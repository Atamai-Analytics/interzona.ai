import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSession } from "@/lib/auth";
import { admit } from "@/lib/guard";
import { datasetName } from "@/lib/geochem-methods";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Geostatistics page, step 4: a short written interpretation of the gridded result. The browser sends the numbers it computed (data summary,
// variogram, cross-validation, grid statistics, highest cells) and a picture of the estimate grid; this route only writes text. One run
// counts as one question against the visitor's limits (src/lib/guard.ts). Events (NDJSON): text deltas, done | error.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.GEOCHEM_MODEL || process.env.CHAT_MODEL || "claude-sonnet-5-5";
const MAX_SUMMARY_CHARS = 24000;
const MAX_IMAGE_CHARS = 2_000_000;

const SYSTEM = `You are an experienced exploration geochemist and geostatistician writing the interpretation panel of a gridding tool. The user
chose ONE survey, ONE analytical method and ONE element for soil, till or lake-sediment samples in an area, and the tool built an interpolated
surface (ordinary kriging or inverse-distance weighting) in log or raw units. You receive the numbers the tool computed and a picture of the
estimate grid (north up; colours from low = dark purple to high = yellow; blank cells are too far from any sample).

Write a concise interpretation in Markdown (about 250-450 words) with these headings:
## Summary (2-3 sentences)
## Spatial structure (what the variogram says: nugget share, range in km versus sample spacing, what that means for how far a sample "speaks")
## Patterns and anomalies (where the highest values sit, using the coordinates given; whether they rest on several samples or one)
## How far to trust this (cross-validation numbers, below-detection share, sample density, edge effects, the random draw if one was made)
## Suggested next steps

Rules:
- Use only the numbers and the picture. Quote them. Never invent sample names, places, deposits or values; give locations only as the
  coordinates supplied. Do not claim mineralisation is present: talk about anomalies and follow-up.
- Explain that kriging smooths: single high samples are pulled down, so the sample points matter as much as the surface. A high nugget share
  (above about 50%) means much of the variation is at shorter distances than the sample spacing or is analytical/sampling noise.
- Cross-validation: mean error near 0 means unbiased; the mean squared standardised error near 1 means the kriging error map is honest
  (much above 1 = errors understated, much below = overstated). Correlation of observed vs predicted shows how much of the pattern is
  predictable from neighbours.
- Values in log units are log10 of the concentration; a back-transformed estimate is closer to a median than a mean.
- Till reflects glacial transport (anomalies can be displaced down-ice from their source); lake sediments reflect their catchment; soils
  reflect the local substrate. Say which applies.
- Plain professional English for a mixed audience. Do not add a data-credits section: the page shows the credits.`;

type Body = { summary: Record<string, unknown>; image: string | null };

function parse(body: unknown): Body {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!b.summary || typeof b.summary !== "object" || Array.isArray(b.summary)) throw new Error("Run the interpolation first.");
  if (JSON.stringify(b.summary).length > MAX_SUMMARY_CHARS) throw new Error("The summary is too large.");
  const image = typeof b.image === "string" && b.image.length < MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/.test(b.image) ? b.image : null;
  return { summary: b.summary as Record<string, unknown>, image };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status: 400 });
  }
  const source = typeof body.summary.dataset === "string" ? body.summary.dataset : "";
  const element = typeof body.summary.element === "string" ? body.summary.element.slice(0, 3) : "";
  const session = await getSession(req);
  const admission = await admit(req, { session, question: `Geostatistics page: ${element} grid, ${datasetName(source).slice(0, 80)}` });
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
        try { controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { closed = true; }
      };
      let outcome = "answered";
      try {
        const content: Anthropic.ContentBlockParam[] = [
          { type: "text", text: `Dataset: ${datasetName(source)} (${source})\nNumbers computed by the tool (JSON):\n${JSON.stringify(body.summary)}` },
        ];
        if (body.image) {
          content.push({ type: "text", text: "Picture of the estimate grid:" });
          content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: body.image } });
        }
        content.push({ type: "text", text: "Write the interpretation now." });
        const s = anthropic.messages.stream({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content }] }, { signal: req.signal });
        s.on("text", (delta) => emit({ type: "text", text: delta }));
        const final = await s.finalMessage();
        totals.turns = 1;
        totals.input = final.usage.input_tokens;
        totals.cache_read = final.usage.cache_read_input_tokens ?? 0;
        totals.cache_write = final.usage.cache_creation_input_tokens ?? 0;
        totals.output = final.usage.output_tokens;
        emit({ type: "done" });
      } catch (e) {
        outcome = req.signal.aborted ? "stopped" : "error";
        console.error("[geostat/interpret] failed:", String(e).slice(0, 300));
        emit({ type: "error", message: "The interpretation could not be written. Please try again." });
      } finally {
        await admission.finish(totals, { outcome, tools: ["geostatistics page"], ms: Date.now() - started });
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
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
