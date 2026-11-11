import assert from "node:assert/strict";
import test from "node:test";
import { decodeDdgUrl, dedupeSources, parseDuckDuckGo } from "../src/search.ts";

const FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fneon.tech%2Fpricing&amp;rut=abc">Neon Pricing</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fneon.tech%2Fpricing">Plans start at <b>$19</b> per month.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="https://supabase.com/pricing">Supabase Pricing</a>
  <a class="result__snippet" href="https://supabase.com/pricing">Free tier, then $25.</a>
</div>
`;

test("parses duckduckgo html into sources", () => {
  const sources = parseDuckDuckGo(FIXTURE);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].url, "https://neon.tech/pricing");
  assert.equal(sources[0].title, "Neon Pricing");
  assert.ok(sources[0].snippet.includes("$19"));
  assert.equal(sources[1].url, "https://supabase.com/pricing");
});

test("unwraps the ddg redirect parameter", () => {
  assert.equal(
    decodeDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x"),
    "https://example.com/a?b=1",
  );
  assert.equal(decodeDdgUrl("https://example.com/direct"), "https://example.com/direct");
});

test("dedupes by url ignoring trailing slash and hash", () => {
  const sources = dedupeSources([
    { title: "A", url: "https://Example.com/pricing/", snippet: "1" },
    { title: "B", url: "https://example.com/pricing#plans", snippet: "2" },
    { title: "C", url: "https://other.com", snippet: "3" },
  ]);
  assert.equal(sources.length, 2);
});
