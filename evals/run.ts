// Hits a running server and prints latency + tool usage per case.
// Usage: npm run dev (in another terminal), then npm run bench
export {};

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const CASES = [
  "What did I ask you on 3 November?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
  "Is your answer still correct today?",
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What changed in the latest Node release?",
];

interface Result {
  case: string;
  firstTokenMs: number;
  totalMs: number;
  tools: number;
  sources: number;
  chars: number;
  error?: string;
}

async function run(message: string, sessionId: string): Promise<Result> {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });

  const out: Result = { case: message, firstTokenMs: 0, totalMs: 0, tools: 0, sources: 0, chars: 0 };
  if (!res.ok || !res.body) {
    out.error = `HTTP ${res.status}`;
    out.totalMs = Date.now() - started;
    return out;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as { type: string; text?: string; results?: number; sources?: unknown[]; message?: string };
      if (event.type === "token" && !out.firstTokenMs) out.firstTokenMs = Date.now() - started;
      if (event.type === "token") out.chars += event.text?.length ?? 0;
      if (event.type === "tool") out.tools += 1;
      if (event.type === "sources") out.sources = event.sources?.length ?? 0;
      if (event.type === "error") out.error = event.message;
    }
  }

  out.totalMs = Date.now() - started;
  return out;
}

const session = `bench-${Date.now()}`;
const rows: Result[] = [];
for (const message of CASES) rows.push(await run(message, session));

console.table(
  rows.map((r) => ({
    question: r.case.slice(0, 58),
    "first token": r.firstTokenMs ? `${r.firstTokenMs} ms` : "—",
    total: `${r.totalMs} ms`,
    searches: r.tools,
    sources: r.sources,
    chars: r.chars,
    error: r.error ?? "",
  })),
);
