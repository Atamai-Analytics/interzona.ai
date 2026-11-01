import type { Conversation, ConversationMeta } from "./types";

// Conversations are saved in this browser (IndexedDB), not on the server: the app has one shared password and no user
// accounts, and the deployed app must never hold database write access. Every function degrades to "nothing saved" if
// the browser blocks storage (private windows, blocked site data).

const DB_NAME = "cm-assistant";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("conversations")) db.createObjectStore("conversations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function makeMeta(c: Conversation): ConversationMeta {
  const text = c.messages.map((m) => m.content).join("\n").toLowerCase().slice(0, 30000);
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length, searchText: text };
}

/** Drop transient UI state before saving. */
function clean(c: Conversation): Conversation {
  return { ...c, messages: c.messages.map(({ streaming, ...m }) => (void streaming, m)) };
}

export async function listConversations(): Promise<ConversationMeta[]> {
  try {
    const db = await openDb();
    const all = await wrap(db.transaction("meta").objectStore("meta").getAll());
    db.close();
    return (all as ConversationMeta[]).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    const db = await openDb();
    const c = await wrap(db.transaction("conversations").objectStore("conversations").get(id));
    db.close();
    return (c as Conversation) ?? null;
  } catch {
    return null;
  }
}

export async function saveConversation(c: Conversation): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(["conversations", "meta"], "readwrite");
    const cc = clean(c);
    tx.objectStore("conversations").put(cc);
    tx.objectStore("meta").put(makeMeta(cc));
    await done(tx);
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function deleteConversation(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(["conversations", "meta"], "readwrite");
    tx.objectStore("conversations").delete(id);
    tx.objectStore("meta").delete(id);
    await done(tx);
    db.close();
  } catch {
    /* nothing to do */
  }
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const c = await getConversation(id);
  if (!c) return;
  await saveConversation({ ...c, title: title.trim() || c.title });
}

export async function exportAll(): Promise<{ app: string; version: number; exportedAt: string; conversations: Conversation[] }> {
  let conversations: Conversation[] = [];
  try {
    const db = await openDb();
    conversations = (await wrap(db.transaction("conversations").objectStore("conversations").getAll())) as Conversation[];
    db.close();
  } catch {
    /* empty backup */
  }
  return { app: "critical-minerals-assistant", version: 1, exportedAt: new Date().toISOString(), conversations };
}

/** Restores conversations from a backup file; returns how many were imported. Existing conversations with the same id are replaced. */
export async function importAll(json: unknown): Promise<number> {
  const data = json as { app?: string; conversations?: Conversation[] };
  if (!data || data.app !== "critical-minerals-assistant" || !Array.isArray(data.conversations)) throw new Error("This file is not a backup from this assistant.");
  let n = 0;
  for (const c of data.conversations) {
    if (c && typeof c.id === "string" && Array.isArray(c.messages) && typeof c.title === "string") {
      if (await saveConversation({ ...c, createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now() })) n++;
    }
  }
  return n;
}
