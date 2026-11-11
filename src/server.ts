import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { MemoryStore } from "./memory.ts";
import { WebSearch } from "./search.ts";

try {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

const cfg = loadConfig();
const memory = new MemoryStore(cfg.dataDir);
const search = new WebSearch(cfg.search);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(join(publicDir, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      model: cfg.llm.model,
      search: search.provider(),
      llmKey: Boolean(cfg.llm.apiKey),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid JSON body" });
      return;
    }

    const message = String(body.message ?? "").trim();
    const sessionId = String(body.sessionId ?? "default").slice(0, 64);
    if (!message) {
      json(res, 400, { error: "message is required" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    try {
      for await (const event of runTurn({ cfg, memory, search }, sessionId, message, controller.signal)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      res.write(`data: ${JSON.stringify({ type: "error", message: messageText })}\n\n`);
    }
    res.end();
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(cfg.port, () => {
  console.log(`minimi agent  →  http://localhost:${cfg.port}`);
  console.log(`  model:  ${cfg.llm.model}  (${cfg.llm.apiKey ? "key set" : "NO KEY — set LLM_API_KEY"})`);
  console.log(`  search: ${search.provider()}`);
  console.log(`  memory: ${cfg.dataDir}/  (timezone ${cfg.tz})`);
});
