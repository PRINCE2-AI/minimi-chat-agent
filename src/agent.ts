import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.ts";
import { streamChat, type ChatMessage, type ToolCall, type ToolDef } from "./llm.ts";
import { dedupeTurns, extractKeywords, type MemoryStore, type Source } from "./memory.ts";
import { buildFreshnessBlock, buildMemoryBlock, buildSystemPrompt, formatResults } from "./prompt.ts";
import { dedupeSources, type Recency, type WebSearch } from "./search.ts";
import { civilDate, addDays, isFreshnessSensitive, looksReferential, resolveRanges } from "./time.ts";

export type AgentEvent =
  | { type: "memory"; count: number; dates: string[] }
  | { type: "tool"; query: string; results: number; recheck?: boolean }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AgentDeps {
  cfg: AppConfig;
  memory: MemoryStore;
  search: WebSearch;
}

const SEARCH_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web. Use it for anything that can change: prices, releases, versions, people, news, availability. Returns titles, URLs and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Natural language, specific." },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional freshness window for time-sensitive questions.",
        },
      },
      required: ["query"],
    },
  },
};

function parseArgs(raw: string): { query?: string; recency?: Recency } {
  try {
    const value = JSON.parse(raw) as { query?: unknown; recency?: unknown };
    const query = typeof value.query === "string" ? value.query.trim() : undefined;
    const recency = ["day", "week", "month", "year"].includes(String(value.recency))
      ? (value.recency as Recency)
      : undefined;
    return { query, recency };
  } catch {
    return {};
  }
}

// Re-runs the exact searches that produced an earlier answer. This is the whole
// point of the freshness step: compare like with like, not a brand new query.
async function precheck(
  search: WebSearch,
  recalled: { queries: string[] }[],
  signal: AbortSignal,
): Promise<{ query: string; sources: Source[] }[]> {
  const queries = [...new Set(recalled.flatMap((turn) => turn.queries))].slice(-2);
  if (!queries.length) return [];
  return Promise.all(
    queries.map(async (query) => ({
      query,
      sources: await search.search(query, { signal }).catch(() => [] as Source[]),
    })),
  );
}

export async function* runTurn(
  deps: AgentDeps,
  sessionId: string,
  text: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const { cfg, memory, search } = deps;
  if (!cfg.llm.apiKey) {
    throw new Error("LLM_API_KEY is not set. Copy .env.example to .env and add a key.");
  }

  const now = new Date();
  const today = civilDate(now, cfg.tz);

  const ranges = resolveRanges(text, today);
  const byDate = ranges.length ? await memory.inRanges(sessionId, ranges) : [];
  const related =
    !ranges.length && looksReferential(text) ? await memory.relevant(sessionId, text, 3) : [];
  let recalled = dedupeTurns([...byDate, ...related]).slice(-6);
  const freshnessSensitive = isFreshnessSensitive(text);

  // "Has any of them changed?" often shares no keywords with the turn it refers
  // to. If the user is clearly pointing back and nothing matched, fall back to
  // the most recent turn we can actually re-check.
  if (!recalled.length && freshnessSensitive && looksReferential(text)) {
    const withSources = (await memory.turns(sessionId))
      .filter((turn) => turn.queries.length && turn.day >= addDays(today, -30))
      .at(-1);
    if (withSources) recalled = [withSources];
  }

  const history = await memory.recent(sessionId, 8);
  const historyIds = new Set(history.map((turn) => turn.id));

  if (recalled.length) {
    yield { type: "memory", count: recalled.length, dates: recalled.map((turn) => turn.day) };
  }

  const queries: string[] = [];
  const sources: Source[] = [];
  // Everything instructional goes into a single system message: providers that
  // map system -> systemInstruction keep only one, and a second block silently
  // replaces the rules.
  const rules: string[] = [buildSystemPrompt(now, today, cfg.tz)];
  const dialogue: ChatMessage[] = [];

  for (const turn of history) {
    // Dates ride along with the transcript: without them the model cannot answer
    // "what did I ask on 3 November" about a turn it can plainly see.
    dialogue.push({ role: "user", content: `[${turn.day}] ${turn.user}` });
    dialogue.push({ role: "assistant", content: turn.assistant });
  }

  const unseen = recalled.filter((turn) => !historyIds.has(turn.id));
  if (unseen.length) rules.push(buildMemoryBlock(unseen, today));

  if (freshnessSensitive && recalled.some((turn) => turn.queries.length)) {
    const fresh = await precheck(search, recalled, signal);
    if (fresh.length) {
      for (const batch of fresh) {
        queries.push(batch.query);
        sources.push(...batch.sources);
        yield { type: "tool", query: batch.query, results: batch.sources.length, recheck: true };
      }
      // Delivered as context, not as fabricated tool messages: tool-call turns
      // are provider-specific (Gemini signs them) and inventing one would be
      // rejected on the next request.
      const results = fresh.map((batch) => formatResults(batch.query, batch.sources)).join("\n\n");
      rules.push(
        `${buildFreshnessBlock(recalled, dedupeSources(fresh.flatMap((b) => b.sources)), fresh.map((b) => b.query))}\n\n${results}`,
      );
    }
  }

  const build = (extra?: string): ChatMessage[] => [
    { role: "system", content: [...rules, ...(extra ? [extra] : [])].join("\n\n") },
    ...dialogue,
    { role: "user", content: text },
  ];

  const messages = build();

  let answer = "";
  const found: string[] = [];
  const MAX_TOOL_ROUNDS = 2;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    let content = "";
    let calls: ToolCall[] = [];
    for await (const event of streamChat(cfg.llm, messages, [SEARCH_TOOL], signal)) {
      if (event.type === "token") {
        content += event.text;
        yield { type: "token", text: event.text };
      } else {
        calls = event.calls;
      }
    }
    answer += content;
    if (!calls.length) break;

    messages.push({ role: "assistant", content: content || null, tool_calls: calls });

    const executions = await Promise.all(
      calls.map(async (call) => {
        const { query, recency } = parseArgs(call.function.arguments);
        if (!query) return { call, query: "", found: [] as Source[] };
        const results = await search.search(query, { recency, signal }).catch(() => [] as Source[]);
        return { call, query, found: results };
      }),
    );

    for (const execution of executions) {
      const body = execution.query
        ? formatResults(execution.query, execution.found)
        : "Error: query was missing.";
      if (execution.query) {
        queries.push(execution.query);
        sources.push(...execution.found);
        found.push(body);
        yield { type: "tool", query: execution.query, results: execution.found.length };
      }
      messages.push({
        role: "tool",
        tool_call_id: execution.call.id,
        name: "web_search",
        content: body,
      });
    }
  }

  // Some providers ignore tool_choice:"none" and keep calling the tool, so the
  // last pass re-asks with no tool declared and the results as plain context.
  if (!answer.trim() && found.length) {
    for await (const event of streamChat(
      cfg.llm,
      build(`SEARCH RESULTS gathered this turn — answer from these, do not search again:\n\n${found.join("\n\n")}`),
      [],
      signal,
    )) {
      if (event.type === "token") {
        answer += event.text;
        yield { type: "token", text: event.text };
      }
    }
  }

  if (!answer.trim()) {
    answer = "I couldn't get an answer out of the model that time. Ask me again?";
    yield { type: "token", text: answer };
  }

  const cited = dedupeSources(sources).slice(0, 6);
  if (cited.length) yield { type: "sources", sources: cited };

  await memory.append({
    id: randomUUID(),
    sessionId,
    ts: now.toISOString(),
    day: today,
    user: text,
    assistant: answer,
    keywords: extractKeywords(text),
    queries: [...new Set(queries)].slice(-4),
    sources: cited,
    freshnessSensitive,
  });

  yield { type: "done" };
}
