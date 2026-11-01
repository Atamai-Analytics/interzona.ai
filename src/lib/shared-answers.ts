import crypto from "crypto";
import zlib from "zlib";
import { redis } from "@/lib/redis";
import type { Dataset, Evidence, ImageAttachment, MapData } from "@/lib/types";

// Share-this-answer links. Every finished answer is remembered by the server for a day under an unguessable id that goes to the visitor who asked it. "Share this answer"
// turns that remembered copy (never text sent from the browser, so nobody can dress up words as an answer from this app) into a frozen copy kept for 30 days behind a
// public link. Only the one question and its answer are kept: not the rest of the conversation, not who asked (tables show their first rows).

export type Who = { r: "owner" | "guest"; i?: string };
export type SharedAnswer = {
  question: string;
  text: string;
  datasets: Dataset[];
  maps: MapData[];
  evidence: Evidence[];
  images: ImageAttachment[];
  notice?: string;
  /** Rows were cut from a table to keep the copy small. */
  rowsCut: boolean;
  /** Charts drawn in the chat were left out because the copy would have been too large to keep. */
  imagesLeftOut: boolean;
  created: number;
  /** Date the shared link stops working (set when the link is made). */
  sharedUntil?: string;
};

const DAY = 24 * 3600;
const REMEMBER_FOR = DAY;
const SHARE_DAYS = 30;
const MAX_ROWS = 200;
// Upstash accepts requests up to about 1 MB; a copy that will not fit is refused, not truncated.
const MAX_STORED_CHARS = 900_000;
const SHARES_PER_DAY = 30;
const ID_RE = /^an_[A-Za-z0-9_-]{20,40}$/;
const TOKEN_RE = /^at_[A-Za-z0-9_-]{20,40}$/;

const evidenceKey = (e: Evidence) => (e.kind === "document" ? `d|${e.title}|${e.page ?? ""}` : e.kind === "web" ? `w|${e.url}` : `x|${e.label}|${e.detail ?? ""}`);

/** Rebuilds an answer from the stream events the app sent, the same way the browser does (final text only, one map per kind, evidence without repeats). */
function fromLines(lines: string[], question: string): SharedAnswer | null {
  let text = "";
  const datasets: Dataset[] = [];
  const images: ImageAttachment[] = [];
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  const byKind = new Map<string, MapData>();
  let notice: string | undefined;
  for (const l of lines) {
    let ev: { type: string; [k: string]: unknown };
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (ev.type === "error") return null;
    if (ev.type === "text") text += String(ev.delta ?? "");
    else if (ev.type === "turn_end" && ev.final === false) text = "";
    else if (ev.type === "dataset") datasets.push(ev.dataset as Dataset);
    else if (ev.type === "image") images.push(ev.image as ImageAttachment);
    else if (ev.type === "notice") notice = String(ev.message ?? "");
    else if (ev.type === "evidence") {
      for (const e of (ev.items as Evidence[]) ?? []) if (!seen.has(evidenceKey(e)) && seen.add(evidenceKey(e))) evidence.push(e);
    } else if (ev.type === "map") {
      const m = ev.map as MapData;
      const kind = m.title.startsWith("Anomaly screen") ? "leads" : /assets with a known position/.test(m.title) ? "assets" : "places";
      const cur = byKind.get(kind);
      if (!cur || m.points.length > cur.points.length) byKind.set(kind, m);
    }
  }
  if (!text.trim()) return null;
  const maps = (["leads", "assets"] as const).map((k) => byKind.get(k)).filter((x): x is MapData => !!x);
  if (maps.length === 0 && byKind.get("places")) maps.push(byKind.get("places")!);
  let rowsCut = false;
  const kept = datasets.map((d) => {
    if (d.rows.length <= MAX_ROWS) return d;
    rowsCut = true;
    return { ...d, rows: d.rows.slice(0, MAX_ROWS) };
  });
  return { question: question.replace(/\s+/g, " ").trim().slice(0, 1500), text: text.trim(), datasets: kept, maps, evidence, images, notice, rowsCut, imagesLeftOut: false, created: Math.floor(Date.now() / 1000) };
}

const pack = (o: unknown) => zlib.gzipSync(JSON.stringify(o)).toString("base64");
const unpack = <T>(raw: unknown): T | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as T;
  } catch {
    return null;
  }
};

/** Keeps a finished answer for a day and returns the id the visitor can use to share it, or null if it is not shareable (an error, no text, too large). */
export async function rememberAnswer(lines: string[], question: string, who: Who): Promise<string | null> {
  const a = fromLines(lines, question);
  if (!a) return null;
  let packed = pack({ a, who });
  if (packed.length > MAX_STORED_CHARS && a.images.length) {
    a.images = [];
    a.imagesLeftOut = true;
    packed = pack({ a, who });
  }
  if (packed.length > MAX_STORED_CHARS) return null;
  const id = "an_" + crypto.randomBytes(18).toString("base64url");
  await redis([["SET", `ans:${id}`, packed, "EX", REMEMBER_FOR]]);
  return id;
}

export type ShareResult = { ok: true; token: string; expires: string } | { ok: false; status: number; error: string };

export async function shareAnswer(id: unknown, who: Who): Promise<ShareResult> {
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, status: 400, error: "That answer cannot be shared." };
  const day = new Date().toISOString().slice(0, 10);
  const rl = `ans:rl:${who.i ?? "owner"}:${day}`;
  const n = Number((await redis([["INCR", rl], ["EXPIRE", rl, 129600, "NX"]]))[0] ?? 0);
  if (n > SHARES_PER_DAY) return { ok: false, status: 429, error: "That is a lot of share links for one day. Please try again tomorrow." };
  const rec = unpack<{ a: SharedAnswer; who: Who }>((await redis([["GET", `ans:${id}`]]))[0]);
  if (!rec) return { ok: false, status: 404, error: "This answer is too old to share (answers can be shared for a day after they are given). Ask the question again and share the new answer." };
  if (rec.who.r !== who.r || (rec.who.i ?? "") !== (who.i ?? "")) return { ok: false, status: 403, error: "That answer cannot be shared from this account." };
  const token = "at_" + crypto.randomBytes(18).toString("base64url");
  const expires = new Date(Date.now() + SHARE_DAYS * DAY * 1000).toISOString().slice(0, 10);
  await redis([["SET", `ans:share:${token}`, pack({ ...rec.a, sharedUntil: expires }), "EX", SHARE_DAYS * DAY]]);
  return { ok: true, token, expires };
}

export async function getSharedAnswer(token: string): Promise<SharedAnswer | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hit = (await redis([["GET", `ans:share:${token}`]]).catch(() => [null]))[0];
  return unpack<SharedAnswer>(hit);
}
