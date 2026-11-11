import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSession } from "@/lib/auth";
import { admit } from "@/lib/guard";
import { getPool } from "@/lib/db";
import { creditsFromText } from "@/lib/licence";
import { runAnalyticsScript } from "@/lib/sandbox";
import { MAX_METHODS_PER_RUN, MAX_SELECTED_SAMPLES, METHOD_BY_ID, datasetName, isRockSampleType, type GeochemMethod } from "@/lib/geochem-methods";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

// Geochemistry page, step 2: run the chosen analyses on the chosen samples in parallel sandboxes, stream each chart as it finishes, then stream
// a written interpretation of all of them. One run counts as one question against the visitor's limits (src/lib/guard.ts).
// Events (NDJSON): meta, result | failed (one per analysis), text (interpretation deltas), done | error.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.GEOCHEM_MODEL || process.env.CHAT_MODEL || "claude-sonnet-5-5";

/** Script summaries can carry per-sample values for thousands of samples: keep the shape, cut long arrays and long text. */
function compact(summary: string, maxChars: number): string {
  const cut = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) return v.length > 25 ? [...v.slice(0, 25).map((x) => cut(x, depth + 1)), `... ${v.length - 25} more not shown`] : v.map((x) => cut(x, depth + 1));
    if (v && typeof v === "object") {
      if (depth > 6) return "{...}";
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x, depth + 1)]));
    }
    if (typeof v === "number") return Number.isFinite(v) ? Number(v.toPrecision(5)) : v;
    return v;
  };
  let text = summary;
  const start = summary.indexOf("{");
  if (start >= 0) {
    try {
      text = JSON.stringify(cut(JSON.parse(summary.slice(start)), 0));
    } catch {
      /* not JSON: send as text */
    }
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)} ... (cut)` : text;
}

const SYSTEM = `You are an experienced exploration geochemist writing the interpretation panel of a geochemistry tool. The user chose a set of
samples from public geological-survey databases and ran some standard diagrams and indices on them. You receive, for each analysis, the chart
image and the script's numeric summary, plus what the selection contains (datasets, sample types, lithologies, counts).

Write a concise interpretation in Markdown (about 350-600 words) with these headings, skipping any that the analyses do not inform:
## Summary (2-3 sentences: the main conclusions)
## Rock types and magmatic affinity
## Alteration and weathering
## Fertility and mineral potential
## How far to trust this
## Suggested next steps

Rules:
- Use only what the charts and numbers show. Quote the numbers (counts, medians, shares) that support each point, and say how many samples each
  analysis actually used (it can be far fewer than were selected, because each needs particular elements).
- Never invent sample names, locations, deposits or values. Do not claim a deposit or mineralisation is present: talk about signatures and
  potential.
- Be explicit about limits: mixed datasets (different labs and methods), mixed lithologies, small samples, below-detection values, data age, and
  that a random draw of a large dataset is not a targeted survey. Igneous classification diagrams (TAS, Jensen, Pearce, CIPW, Niggli, porphyry
  fertility) are only valid for fresh igneous rocks: if the selection includes sediments, soils, till, altered or metamorphic rocks, say what
  that does to the result.
- If an analysis failed or had too few samples, say so in one line and do not interpret it.
- Plain professional English for a mixed audience (geologists and investors); define an index the first time you use it in a few words.
- Do not add a data-credits section: the page shows the credits.`;

type Body = { ids: number[]; methods: string[] };

function parse(body: unknown): Body {
  const b = (body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((v): v is number => Number.isInteger(v) && (v as number) > 0))].slice(0, MAX_SELECTED_SAMPLES) : [];
  if (ids.length < 5) throw new Error("Select samples first (at least 5).");
  const methods = Array.isArray(b.methods) ? [...new Set(b.methods.filter((m): m is string => typeof m === "string" && m in METHOD_BY_ID))] : [];
  if (methods.length === 0) throw new Error("Choose at least one analysis.");
  if (methods.length > MAX_METHODS_PER_RUN) throw new Error(`Choose at most ${MAX_METHODS_PER_RUN} analyses per run.`);
  return { ids, methods };
}

async function describeSelection(ids: number[]) {
  const r = await getPool().query(
    `SELECT source_system, coalesce(sample_type_name, 'Unknown') sample_type_name, coalesce(lithology_category, 'not recorded') lith, count(*)::int n,
            min(lat) s, max(lat) n_, min(lon) w, max(lon) e
       FROM geochem.sample_chemistry_wide WHERE sample_id = ANY($1::bigint[]) GROUP BY 1, 2, 3`,
    [ids]
  );
  const sum = (key: (row: Record<string, unknown>) => string) => {
    const m = new Map<string, number>();
    for (const row of r.rows) m.set(key(row), (m.get(key(row)) ?? 0) + Number(row.n));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const sources = sum((x) => String(x.source_system));
  const types = sum((x) => String(x.sample_type_name));
  const liths = sum((x) => String(x.lith));
  const nonRock = types.filter(([t]) => !isRockSampleType(t)).reduce((a, [, n]) => a + n, 0);
  const box = r.rows.reduce(
    (b, x) => ({ s: Math.min(b.s, Number(x.s)), n: Math.max(b.n, Number(x.n_)), w: Math.min(b.w, Number(x.w)), e: Math.max(b.e, Number(x.e)) }),
    { s: 90, n: -90, w: 180, e: -180 }
  );
  const fmt = (l: [string, number][]) => l.map(([k, n]) => `${k} ${n.toLocaleString("en-US")}`).join("; ");
  const total = sources.reduce((a, [, n]) => a + n, 0);
  return {
    total,
    sources: sources.map(([s]) => s),
    credits: sources.flatMap(([s]) => creditsFromText(s)).filter((c, i, a) => a.indexOf(c) === i),
    text:
      `Selected samples: ${total.toLocaleString("en-US")} (a random draw from the user's filter).\n` +
      `Datasets: ${sources.map(([s, n]) => `${datasetName(s)} ${n.toLocaleString("en-US")}`).join("; ")}\n` +
      `Sample types: ${fmt(types)}${nonRock ? ` (${nonRock.toLocaleString("en-US")} are not rock samples)` : ""}\n` +
      `Logged lithology categories: ${fmt(liths)}\n` +
      (Number.isFinite(box.s) && box.s <= box.n ? `Area: latitude ${box.s.toFixed(2)} to ${box.n.toFixed(2)}, longitude ${box.w.toFixed(2)} to ${box.e.toFixed(2)}\n` : ""),
  };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status: 400 });
  }
  const methods = body.methods.map((id) => METHOD_BY_ID[id]);
  const session = await getSession(req);
  const question = `Geochemistry page: ${methods.map((m) => m.label).join(", ")} on ${body.ids.length.toLocaleString("en-US")} samples`;
  const admission = await admit(req, { session, question });
  if (!admission.ok) {
    return NextResponse.json(
      { error: admission.message, code: admission.code, retryAfterSec: admission.retryAfterSec },
      { status: admission.status, headers: admission.retryAfterSec ? { "Retry-After": String(admission.retryAfterSec) } : undefined }
    );
  }

  const started = Date.now();
  const totals = { turns: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (e: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true;
        }
      };
      let outcome = "answered";
      try {
        const sel = await describeSelection(body.ids);
        emit({ type: "meta", n: sel.total, sources: sel.sources, credits: sel.credits });

        type Done = { m: GeochemMethod; ok: true; image: string; summary: string } | { m: GeochemMethod; ok: false; message: string };
        const results: Done[] = await Promise.all(
          methods.map(async (m): Promise<Done> => {
            try {
              const r = await runAnalyticsScript(m.script, { sampleIds: body.ids }, m.options ?? {}, "Selected samples");
              if (r.kind !== "image") throw new Error("The analysis returned no chart.");
              const done: Done = { m, ok: true, image: r.base64, summary: r.summary };
              emit({ type: "result", id: m.id, label: m.label, image: r.base64, summary: compact(r.summary, 20000) });
              return done;
            } catch (e) {
              // Script errors carry Python tracebacks: keep the last line, which states the reason (e.g. too few samples with Th, Nb, Yb).
              const raw = e instanceof Error ? e.message : String(e);
              const line = raw.split("\n").map((s) => s.trim()).filter(Boolean).filter((s) => /Error|error|samples|None of/.test(s)).pop() ?? raw.slice(0, 200);
              const message = line.replace(/^\w*Error:\s*/, "").slice(0, 300);
              console.warn(`[geochem/analyse] ${m.id} failed: ${raw.slice(0, 300)}`);
              emit({ type: "failed", id: m.id, label: m.label, message });
              return { m, ok: false, message };
            }
          })
        );

        if (results.every((r) => !r.ok)) {
          emit({ type: "text", text: "None of the analyses could run on this selection, so there is nothing to interpret. Check the usable-sample counts and try a selection with the elements these analyses need." });
          outcome = "error";
        } else {
          const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: `${sel.text}\nAnalyses run:` }];
          for (const r of results) {
            if (r.ok) {
              content.push({ type: "text", text: `\n### ${r.m.label} (${r.m.blurb})\nNumeric summary from the script:\n${compact(r.summary, 6000)}` });
              content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: r.image } });
            } else {
              content.push({ type: "text", text: `\n### ${r.m.label}: FAILED - ${r.message}` });
            }
          }
          content.push({ type: "text", text: "\nWrite the interpretation now." });
          const s = anthropic.messages.stream({ model: MODEL, max_tokens: 3000, system: SYSTEM, messages: [{ role: "user", content }] }, { signal: req.signal });
          s.on("text", (delta) => emit({ type: "text", text: delta }));
          const final = await s.finalMessage();
          totals.turns = 1;
          totals.input = final.usage.input_tokens;
          totals.cache_read = final.usage.cache_read_input_tokens ?? 0;
          totals.cache_write = final.usage.cache_creation_input_tokens ?? 0;
          totals.output = final.usage.output_tokens;
        }
        emit({ type: "done" });
      } catch (e) {
        outcome = req.signal.aborted ? "stopped" : "error";
        console.error("[geochem/analyse] failed:", String(e).slice(0, 300));
        emit({ type: "error", message: "The analysis could not be completed. Please try again, or with fewer analyses." });
      } finally {
        await admission.finish(totals, { outcome, tools: ["geochem page", ...methods.map((m) => m.id)], ms: Date.now() - started });
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...(admission.setCookie ? { "Set-Cookie": admission.setCookie } : {}),
    },
  });
}
