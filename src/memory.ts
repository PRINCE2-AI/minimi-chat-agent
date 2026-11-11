import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DayRange } from "./time.ts";

export interface Source {
  title: string;
  url: string;
  snippet: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  ts: string;
  day: string; // civil date in the app timezone, e.g. "2026-11-03"
  user: string;
  assistant: string;
  keywords: string[];
  queries: string[]; // the exact searches behind the answer
  sources: Source[]; // what the answer was grounded in
  freshnessSensitive: boolean;
}

const STOP = new Set(
  `a an the and or but if then than that this these those there here is are was were be been being am
   do does did done have has had having i you he she it we they me my your our their us them
   of to in on for with at by from as about into over after before between during without within
   so not no yes can could should would will just very really also only more most much many some any
   what when where who why how which whose please tell show give me about`.split(/\s+/),
);

export function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const word = raw.replace(/^\.+|\.+$/g, "");
    if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);
}

function safeSession(sessionId: string): string {
  const clean = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return clean || "default";
}

// Append-only JSONL, one file per session. One writer, no locks, no native
// dependencies. The whole session is cached in memory keyed by file size.
export class MemoryStore {
  private cache = new Map<string, { size: number; turns: Turn[] }>();

  constructor(private dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${safeSession(sessionId)}.jsonl`);
  }

  async append(turn: Turn): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(turn.sessionId), `${JSON.stringify(turn)}\n`, "utf8");
    this.cache.delete(turn.sessionId);
  }

  async turns(sessionId: string): Promise<Turn[]> {
    let raw = "";
    try {
      raw = await readFile(this.file(sessionId), "utf8");
    } catch {
      return [];
    }
    const cached = this.cache.get(sessionId);
    if (cached && cached.size === raw.length) return cached.turns;

    const turns: Turn[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        turns.push(JSON.parse(line) as Turn);
      } catch {
        // A torn last line from a killed process should not lose the session.
      }
    }
    this.cache.set(sessionId, { size: raw.length, turns });
    return turns;
  }

  async recent(sessionId: string, limit: number): Promise<Turn[]> {
    const turns = await this.turns(sessionId);
    return turns.slice(-limit);
  }

  async inRanges(sessionId: string, ranges: DayRange[]): Promise<Turn[]> {
    if (!ranges.length) return [];
    const turns = await this.turns(sessionId);
    return turns.filter((turn) => ranges.some((r) => turn.day >= r.from && turn.day <= r.to));
  }

  async relevant(sessionId: string, text: string, limit = 3): Promise<Turn[]> {
    const wanted = new Set(extractKeywords(text));
    if (!wanted.size) return [];
    const turns = await this.turns(sessionId);
    const scored = turns
      .slice(-200)
      .map((turn, index) => ({
        turn,
        index,
        score: turn.keywords.filter((k) => wanted.has(k)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index);
    return scored.slice(0, limit).map((item) => item.turn);
  }
}

export function dedupeTurns(turns: Turn[]): Turn[] {
  const seen = new Set<string>();
  const out: Turn[] = [];
  for (const turn of turns) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    out.push(turn);
  }
  return out;
}
