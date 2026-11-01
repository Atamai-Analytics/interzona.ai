import crypto from "crypto";
import zlib from "zlib";
import { redis } from "@/lib/redis";

// Saved answers for the demo cards. A card's question is asked live once by the owner (recording), the answer is reviewed, and then approved. From then
// on the same question returns the saved answer (every chart, map, table and source included) instantly and without model cost, with a note saying
// when it was saved. Any other wording runs live as usual. An answer is a recording of the stream the app sent, so it looks exactly like a live one.

export type Pinned = { prompt: string; asOf: number; lines: string[] };
export type DemoInfo = { hash: string; prompt: string; status: "approved" | "draft" | "both"; approvedAt: number | null; draftAt: number | null; draftBytes: number };

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
export const promptHash = (prompt: string) => crypto.createHash("sha256").update(normalize(prompt)).digest("hex").slice(0, 16);

// Upstash accepts requests up to about 1 MB; saved answers are compressed, and one too large to store is refused, not truncated.
const MAX_STORED_CHARS = 900_000;
const pack = (p: Pinned) => zlib.gzipSync(JSON.stringify(p)).toString("base64");
const unpack = (raw: unknown): Pinned | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as Pinned;
  } catch {
    return null;
  }
};

export async function getApproved(prompt: string): Promise<Pinned | null> {
  return unpack((await redis([["GET", `demo:live:${promptHash(prompt)}`]]))[0]);
}

/** Stores a recording as a draft. The usage figures are dropped: a saved answer must not report model use that did not happen. */
export async function saveDraft(prompt: string, lines: string[]): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const kept = lines.filter((l) => !/^\{"type":"usage"/.test(l));
  if (kept.some((l) => /^\{"type":"error"/.test(l))) return { ok: false, error: "The answer contained an error, so it was not saved." };
  if (!kept.some((l) => /^\{"type":"done"/.test(l))) return { ok: false, error: "The answer did not finish, so it was not saved." };
  const packed = pack({ prompt: normalize(prompt), asOf: Math.floor(Date.now() / 1000), lines: kept });
  if (packed.length > MAX_STORED_CHARS) return { ok: false, error: `The answer is too large to store (${Math.round(packed.length / 1024)} KB).` };
  const h = promptHash(prompt);
  await redis([["SET", `demo:draft:${h}`, packed], ["SADD", "demos", h]]);
  return { ok: true, bytes: packed.length };
}

/** Replaces the written answer in a draft (charts, maps, tables and sources are kept), so the owner can correct a sentence before approving. */
export async function editDraft(hash: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[a-f0-9]{16}$/.test(hash)) return { ok: false, error: "Unknown card." };
  const d = unpack((await redis([["GET", `demo:draft:${hash}`]]))[0]);
  if (!d) return { ok: false, error: "There is no draft to edit." };
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length < 20 || clean.length > 20_000) return { ok: false, error: "The answer text must be between 20 and 20,000 characters." };
  const keep = d.lines.filter((l) => !/^\{"type":"(text|turn_end|done)"/.test(l));
  const chunks = clean.match(/[\s\S]{1,60}/g) ?? [];
  const lines = [...keep, ...chunks.map((c) => JSON.stringify({ type: "text", delta: c })), JSON.stringify({ type: "turn_end", final: true }), JSON.stringify({ type: "done" })];
  await redis([["SET", `demo:draft:${hash}`, pack({ prompt: d.prompt, asOf: d.asOf, lines })]]);
  return { ok: true };
}

export async function approve(hash: string): Promise<boolean> {
  if (!/^[a-f0-9]{16}$/.test(hash)) return false;
  const draft = (await redis([["GET", `demo:draft:${hash}`]]))[0];
  if (typeof draft !== "string") return false;
  await redis([["SET", `demo:live:${hash}`, draft], ["DEL", `demo:draft:${hash}`]]);
  return true;
}

export async function remove(hash: string, which: "approved" | "draft"): Promise<void> {
  if (!/^[a-f0-9]{16}$/.test(hash)) return;
  await redis([["DEL", which === "approved" ? `demo:live:${hash}` : `demo:draft:${hash}`]]);
}

export async function listDemos(): Promise<DemoInfo[]> {
  const hashes = ((await redis([["SMEMBERS", "demos"]]))[0] as string[]) ?? [];
  if (hashes.length === 0) return [];
  const replies = await redis([...hashes.map((h) => ["GET", `demo:live:${h}`]), ...hashes.map((h) => ["GET", `demo:draft:${h}`])]);
  const out: DemoInfo[] = [];
  hashes.forEach((h, i) => {
    const live = unpack(replies[i]);
    const draftRaw = replies[hashes.length + i];
    const draft = unpack(draftRaw);
    if (!live && !draft) return;
    out.push({
      hash: h,
      prompt: (live ?? draft)!.prompt,
      status: live && draft ? "both" : live ? "approved" : "draft",
      approvedAt: live?.asOf ?? null,
      draftAt: draft?.asOf ?? null,
      draftBytes: typeof draftRaw === "string" ? draftRaw.length : 0,
    });
  });
  return out.sort((a, b) => a.prompt.localeCompare(b.prompt));
}

/** The text of a draft's answer, so the owner can review it before approving. */
export async function draftAnswer(hash: string): Promise<{ prompt: string; asOf: number; text: string; maps: number; datasets: number; images: number; sources: number } | null> {
  if (!/^[a-f0-9]{16}$/.test(hash)) return null;
  const d = unpack((await redis([["GET", `demo:draft:${hash}`]]))[0]);
  if (!d) return null;
  let text = "";
  let maps = 0, datasets = 0, images = 0, sources = 0;
  for (const l of d.lines) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "turn_end" && !ev.final) text = "";
      else if (ev.type === "map") maps++;
      else if (ev.type === "dataset") datasets++;
      else if (ev.type === "image") images++;
      else if (ev.type === "evidence") sources += ev.items?.length ?? 0;
    } catch {
      /* ignore a malformed line */
    }
  }
  return { prompt: d.prompt, asOf: d.asOf, text, maps, datasets, images, sources };
}

const fmtDate = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The note shown under a saved answer, and kept in a shared copy of it. */
export const savedNotice = (p: Pinned) => `Saved answer, last refreshed ${fmtDate(p.asOf)}. Ask in different words to run it live on today's data.`;

/** Replays a saved answer as the same newline-delimited stream a live answer uses, paced so it reads as it arrives, with a note saying it is saved. */
export function replayResponse(p: Pinned, headers: Record<string, string> = {}, answerId?: string | null): Response {
  const encoder = new TextEncoder();
  const lines = p.lines.filter((l) => !/^\{"type":"done"/.test(l));
  lines.push(JSON.stringify({ type: "notice", message: savedNotice(p) }));
  if (answerId) lines.push(JSON.stringify({ type: "answer", id: answerId }));
  lines.push(JSON.stringify({ type: "done" }));
  const gap = Math.min(12, Math.floor(2500 / Math.max(1, lines.length)));
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const l of lines) {
          controller.enqueue(encoder.encode(l + "\n"));
          if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        }
      } catch {
        /* the reader went away */
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", ...headers },
  });
}
