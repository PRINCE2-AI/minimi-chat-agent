import type { LlmConfig } from "./config.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  // Gemini 3 returns a signed "thought" blob with every function call and
  // rejects the next turn if it is not echoed back verbatim.
  extra_content?: unknown;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "end"; content: string; calls: ToolCall[] };

interface Delta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    extra_content?: unknown;
    function?: { name?: string; arguments?: string };
  }[];
}

// Minimal OpenAI-compatible streaming client. No SDK: one POST, one SSE loop.
const REQUEST_TIMEOUT_MS = 60_000;

export async function* streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // A provider that stalls must not stall the turn: cap every attempt.
  const attempt = async (): Promise<Response> => {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      return await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          // Gemini's OpenAI-compatible stream rejects parallel function calls with a
          // bare 400, so tool use is one call per round.
          ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
          ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
          temperature: 0.3,
          stream: true,
        }),
        signal: abort,
      });
    } catch (err) {
      if (deadline.aborted) {
        throw new Error(`model ${cfg.model} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  };

  let res = await attempt();
  if (res.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res = await attempt();
  }

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`model ${res.status}: ${detail || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let content = "";
  const calls: ToolCall[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;

    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let chunk: { choices?: { delta?: Delta }[] };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        yield { type: "token", text: delta.content };
      }

      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0;
        const call =
          calls[index] ??
          (calls[index] = { id: "", type: "function", function: { name: "", arguments: "" } });
        if (part.id) call.id = part.id;
        if (part.extra_content) call.extra_content = part.extra_content;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
    }
  }

  const complete = calls.filter((call): call is ToolCall => Boolean(call));
  complete.forEach((call, index) => {
    if (!call.id) call.id = `call_${index}`;
  });

  // Providers can answer 200 with an empty stream or a plain JSON error body
  // instead of SSE. Surface that instead of returning a silent empty answer.
  if (!content && complete.length === 0) {
    const detail = raw.trim().slice(0, 300);
    throw new Error(
      `model ${cfg.model} returned no content${detail ? `: ${detail}` : " (empty stream)"}`,
    );
  }

  yield { type: "end", content, calls: complete };
}
