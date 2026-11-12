# DESIGN

One tool, one streamed model loop, one append-only memory. The interesting part is not
the chat — it is what the harness does **before** the model speaks.

```
browser ──POST /api/chat──▶ server ──▶ agent.ts
                                        │
                     ┌──────────────────┼───────────────────┐
                     ▼                  ▼                   ▼
              resolve dates       memory recall      freshness pre-check
              ("3 Nov")          (JSONL, by day)     (re-run stored queries)
                     └──────────────────┼───────────────────┘
                                        ▼
                              one streamed model call
                              └── tools: 2 rounds, then 1 clean answer ──▶ web_search
                                        ▼
                         tokens → SSE → browser ; sources attached
                                        ▼
                                append turn to JSONL
```

## 1. Memory is harness state, not a tool

The brief allows one tool. Memory is therefore not a tool: the model never decides
whether to remember, it is simply handed the right slice of history.

Each finished turn is appended to `.data/<session>.jsonl` with `day` — a **civil date**
computed in the user's timezone (`Asia/Kolkata` by default). Storing the civil date
instead of trusting UTC instants is what makes "what did I ask on 3 November" exact
rather than off-by-one at midnight.

Before the model runs, `src/time.ts` resolves every date expression in the message —
`3 November`, `3rd of November`, `November 3`, `2026-11-03`, `yesterday`, `3 days ago`,
`last Tuesday`, `last week`, `last month` — into inclusive ranges. A bare date always
resolves backwards, because recall questions are about the past. All of this is regex
and calendar arithmetic: zero model tokens, zero drift, testable.

Recall is the union of (a) turns inside those date ranges and (b) turns sharing at least
one extracted keyword with the question, filtered to the session. The result is injected
as a verbatim block with dates and the sources that were cited then, and the model is
told to use it exactly and never invent a past question.

Measured on a synthetic 10,000-turn session: cold load 49 ms, date-range lookup 13.7 ms,
lexical recall 6.6 ms, last-8 turns 4.9 ms. That is why there is no vector database —
at this scale it would add a dependency, an embedding cost, and worse precision on
"What did I ask on 3 November" than a date filter.

## 2. "Has it changed?" is a pre-step, not a model decision

Every turn stores the exact `queries` it ran and the `sources` it was grounded in.

When a new message is freshness-sensitive (`price`, `pricing`, `changed`, `still`,
`latest`, `version`, `shipped`, …) **and** the context it points at is a turn with
stored queries, the harness re-runs those same queries before the first model call,
then injects:

- the fresh search results as plain text, in the same message as the rules, and
- a `FRESHNESS CHECK` block: the answer from then, the query list, source counts,
  which URLs are new, which are gone, which were kept.

The model is told not to claim "nothing changed" from URL identity alone, because
snippets change without the URL changing. The prompt fixes the answer shape: what was
true then and when → what is true now → the difference.

**Why before the model, not after:** a "nudge the model to re-check" loop lets it start
streaming a stale answer, then corrects it — the user reads the wrong sentence first.
The pre-step costs ~0.3–0.8 s per query only on the turns that need it, and every token
that reaches the browser is grounded in a fresh search.

"Has any of them changed since?" often shares no keyword with the turn it points at, so
when nothing recall-able matches and the message is still referential (`it`, `them`,
`that`, `still`, `since`), the harness falls back to the most recent turn with stored
queries from the last 30 days. A follow-up does not need to name the thing again.

## 3. One streamed call, no framework

The whole agent loop is under 100 lines in `src/agent.ts`: stream a completion, collect
the tool call, run it, append the result, repeat at most twice, then one final pass with
the tool removed so the turn always ends in prose. The client is a plain `fetch` + SSE
parser in `src/llm.ts` — no SDK.

Three provider quirks shaped that loop, and each is a line of code rather than a
framework:

- Gemini signs every function call with a `thought_signature` and rejects the next
  request if it is not echoed back, so tool calls are stored and replayed verbatim.
- The same endpoint answers `400` to parallel function calls in a stream, so
  `parallel_tool_calls` is off and each round is one search.
- It also ignores `tool_choice: "none"`, so the last pass is a fresh request with no
  tool declared and the collected results as context. Only one system message is sent
  per request: a second one silently replaced the rules instead of adding to them.

No LangChain/LangGraph. For one tool and three rounds it would add a dependency, hide
prompt rewrites, and make the freshness pre-step awkward to express. Everything here is
readable in one sitting, which is also the point of the challenge.

Latency choices: one model call instead of plan-then-act, a 10-minute in-process search
cache keyed by `query + recency`, five results max, sources deduped by normalized URL
(trailing slash and hash ignored), a 60 s cap per model request, and one retry on the
provider's `503 high demand`. The UI renders `[1]`-style citations from actual tool
output, so a citation cannot be hallucinated.

## What I considered and rejected

| Option | Why not |
| --- | --- |
| Memory as an LLM tool | Two extra round trips (~1–3 s) and a model that can forget to look. |
| Embeddings / vector DB | Recall here is one date plus a few keywords. Lexical + date is faster and more precise. |
| Always search | Slower, and adds noise to pure recall questions. |
| Planner / multi-agent | No accuracy gain for a single read-only tool; large latency cost. |
| Client-only history | The server could not diff what changed since then. |

## Safety

Web results are untrusted data: the prompt forbids following instructions found inside
them, and results arrive only as tool output. The single tool is read-only, so an
injected page can at most be cited. Secrets come from env only (`.env` is gitignored),
sessions are isolated files, and request bodies are capped at 64 KB.

## Limits

Single process, single writer — fine for one user, not multi-tenant. JSONL cold-start is
O(n) (49 ms at 10k turns). The keyless DuckDuckGo fallback is rate-limit prone; with
Tavily or Brave it is stable. There is no auth, so do not expose it publicly as-is.

## Another week

1. **Watchlist.** minimi's product is proactive pings. Promote a stored turn into a
   watched entity + query, re-check it on a schedule, and notify only when the source
   diff is non-empty. That turns this from a chat demo into the actual product.
2. **Content hashing per URL** so "snippet changed" is detected even when the URL set is
   identical — today the model reads the text, but the harness cannot score it.
3. **A 50-question eval** scoring answer correctness, freshness correctness, and
   p50/p95 first-token latency, run in CI.
4. **Speculative search**: start the search while the model is still emitting its first
   sentence, cancel if the tool call never comes.
