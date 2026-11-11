# minimi chat agent

A chat agent with exactly one tool — `web_search` — and a memory that knows *when* you asked.

Built for minimi's hiring challenge. Node + TypeScript, no agent framework.

```bash
cp .env.example .env      # add LLM_API_KEY (and optionally TAVILY_API_KEY)
npm install
npm run dev               # http://localhost:3000
```

Any OpenAI-compatible endpoint works: set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
Search providers, in priority order: Tavily → Brave → DuckDuckGo (no key needed).

## What it does differently

**It remembers dates, not just text.** "What did I ask you on 3 November?" is resolved
deterministically in code — no tokens spent on date math — then matched against the
session log. The recalled turns are injected verbatim with their dates.

**"Has anything changed?" is answered, not guessed.** Every turn stores the exact
queries and sources it was grounded in. When a later question is freshness-sensitive
and points back at an earlier turn, the harness re-runs those same queries *before the
model speaks*, computes a source diff, and hands the model the comparison. The answer
comes out as: what was true then → what is true now → the delta.

**Answers stream.** One model call, streamed over SSE. Tool calls loop at most three
rounds. Sources are attached by the harness from real tool results, so citations cannot
be invented.

Read [DESIGN.md](DESIGN.md) for the reasoning and the rejected alternatives.

## Files

```
src/server.ts    HTTP + SSE, serves the UI
src/agent.ts     the turn: recall → freshness pre-check → model/tool loop → persist
src/memory.ts    append-only JSONL per session, keyword extraction, recall
src/time.ts      "3 November" / "last Tuesday" / "last month" → civil date ranges
src/prompt.ts    system prompt, memory block, freshness diff block
src/search.ts    Tavily / Brave / DuckDuckGo + cache + URL dedupe
src/llm.ts       streaming OpenAI-compatible client (no SDK)
public/index.html  the chat UI
```

## Commands

```bash
npm test        # 14 unit tests: dates, recall, DDG parsing, dedupe
npm run bench   # hit a running server, print latency per question
npm run typecheck
```

`npm run bench` expects the dev server on `http://localhost:3000` (override with `BASE_URL`).

## Example prompts

- `What did I ask you on 3 November?`
- `Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?`
- `On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?`
- `What changed in the latest Node release?`
