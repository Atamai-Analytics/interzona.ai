export type ImageAttachment = { mimeType: string; base64: string; caption: string };

export type Evidence =
  | { kind: "document"; title: string; page?: number }
  | { kind: "web"; title: string; url: string }
  | { kind: "data"; label: string; detail?: string };

export type Dataset = {
  id: string;
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  chart?: { unit: string; series: { name: string; points: [string, number][] }[] };
  /** Horizontal bars, one per item, with an optional second value to compare against (for example a regional background). */
  bars?: { unit: string; legend: [string, string?]; items: { label: string; value: number; compare?: number }[] };
};

export type Step = { id: string; label: string; status: "running" | "done" | "error"; ms?: number };

export type Message = {
  role: "user" | "assistant";
  content: string;
  images?: ImageAttachment[];
  steps?: Step[];
  evidence?: Evidence[];
  datasets?: Dataset[];
  maps?: MapData[];
  streaming?: boolean;
  notice?: string;
  /** Id the server gave this finished answer, used to make a share link (the server keeps the answer for a day). */
  answerId?: string;
  stopped?: boolean;
  /** The visitor's thumbs up/down on this answer (sent = it reached the server). */
  feedback?: { rating: "up" | "down"; sent: boolean };
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
};

/** Light record kept for the history list and search, so the list never has to load images and data. */
export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  searchText: string;
};

/** A set of places to show on a map. Groups colour the markers; size (optional) scales the marker radius. */
export type MapPoint = { lat: number; lon: number; label: string; group: string; detail?: string; size?: number };
export type MapData = { id: string; title: string; note?: string; points: MapPoint[] };
