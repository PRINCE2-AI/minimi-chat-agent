import type { SearchConfig } from "./config.ts";
import type { Source } from "./memory.ts";

export type Recency = "day" | "week" | "month" | "year";

export interface SearchOptions {
  recency?: Recency;
  signal?: AbortSignal;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 5;

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeDdgUrl(href: string): string {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  if (absolute.includes("uddg=")) {
    try {
      // searchParams already percent-decodes the target URL.
      return new URL(absolute).searchParams.get("uddg") || absolute;
    } catch {
      return absolute;
    }
  }
  return absolute;
}

export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    if (!source.url) continue;
    const key = source.url.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

// Exported for tests: pure HTML -> results.
export function parseDuckDuckGo(html: string): Source[] {
  const titles: { url: string; title: string }[] = [];
  const snippets: string[] = [];

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = match[1];
    const inner = stripHtml(match[2]);
    const isTitle = /class="[^"]*result__a/.test(attrs);
    const isSnippet = /class="[^"]*result__snippet/.test(attrs);
    if (isTitle) {
      const href = /href="([^"]+)"/.exec(attrs)?.[1];
      if (!href || !inner) continue;
      const url = decodeDdgUrl(href.replace(/&amp;/g, "&"));
      if (url.includes("duckduckgo.com")) continue;
      titles.push({ url, title: inner });
    } else if (isSnippet && inner) {
      snippets.push(inner);
    }
  }

  return titles.map((item, index) => ({
    title: item.title,
    url: item.url,
    snippet: snippets[index] ?? "",
  }));
}

export class WebSearch {
  private cache = new Map<string, { at: number; results: Source[] }>();

  constructor(private cfg: SearchConfig) {}

  provider(): "tavily" | "brave" | "duckduckgo" {
    if (this.cfg.tavilyKey) return "tavily";
    if (this.cfg.braveKey) return "brave";
    return "duckduckgo";
  }

  async search(query: string, options: SearchOptions = {}): Promise<Source[]> {
    const q = query.trim().slice(0, 400);
    if (!q) return [];

    const key = `${this.provider()}|${q}|${options.recency ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(9000)])
      : AbortSignal.timeout(9000);

    let results: Source[] = [];
    try {
      if (this.provider() === "tavily") results = await this.tavily(q, options.recency, signal);
      else if (this.provider() === "brave") results = await this.brave(q, options.recency, signal);
      else results = await this.duckduckgo(q, signal);
    } catch {
      return [];
    }

    results = dedupeSources(results).slice(0, MAX_RESULTS);
    this.cache.set(key, { at: Date.now(), results });
    return results;
  }

  private async tavily(query: string, recency: Recency | undefined, signal: AbortSignal): Promise<Source[]> {
    const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 30 : recency === "year" ? 365 : undefined;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.cfg.tavilyKey,
        query,
        max_results: MAX_RESULTS,
        search_depth: "basic",
        ...(days ? { days } : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.content ?? "").slice(0, 400),
    }));
  }

  private async brave(query: string, recency: Recency | undefined, signal: AbortSignal): Promise<Source[]> {
    const freshness = recency === "day" ? "pd" : recency === "week" ? "pw" : recency === "month" ? "pm" : recency === "year" ? "py" : undefined;
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(MAX_RESULTS));
    if (freshness) url.searchParams.set("freshness", freshness);
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": this.cfg.braveKey ?? "" },
      signal,
    });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.description ?? "").slice(0, 400),
    }));
  }

  private async duckduckgo(query: string, signal: AbortSignal): Promise<Source[]> {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      signal,
    });
    if (!res.ok) throw new Error(`ddg ${res.status}`);
    return parseDuckDuckGo(await res.text());
  }
}
