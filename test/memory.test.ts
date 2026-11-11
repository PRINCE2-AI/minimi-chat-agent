import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore, extractKeywords, type Turn } from "../src/memory.ts";

function turn(overrides: Partial<Turn>): Turn {
  return {
    id: "t1",
    sessionId: "s1",
    ts: "2026-11-03T10:00:00.000Z",
    day: "2026-11-03",
    user: "",
    assistant: "",
    keywords: [],
    queries: [],
    sources: [],
    freshnessSensitive: false,
    ...overrides,
  };
}

test("appends, reloads and filters turns by civil date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minimi-"));
  try {
    const store = new MemoryStore(dir);
    const user = "Which Postgres host should I use for a side project?";
    await store.append(
      turn({ id: "a", user, assistant: "Neon, because of branching.", keywords: extractKeywords(user), queries: ["postgres hosting pricing"] }),
    );
    await store.append(
      turn({ id: "b", day: "2026-11-09", ts: "2026-11-09T10:00:00.000Z", user: "Shortlist 5 CRM tools", keywords: extractKeywords("Shortlist 5 CRM tools") }),
    );

    const all = await store.turns("s1");
    assert.equal(all.length, 2);

    const onThird = await store.inRanges("s1", [{ from: "2026-11-03", to: "2026-11-03", label: "2026-11-03" }]);
    assert.equal(onThird.length, 1);
    assert.equal(onThird[0].id, "a");

    const lastWeek = await store.inRanges("s1", [{ from: "2026-11-04", to: "2026-11-10", label: "last week" }]);
    assert.deepEqual(lastWeek.map((t) => t.id), ["b"]);

    const recent = await store.recent("s1", 1);
    assert.equal(recent[0].id, "b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lexical recall finds the earlier postgres turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minimi-"));
  try {
    const store = new MemoryStore(dir);
    const postgres = "My Postgres hosting bill is going up, what are my options?";
    await store.append(turn({ id: "a", user: postgres, assistant: "Neon and Supabase.", keywords: extractKeywords(postgres) }));
    await store.append(
      turn({ id: "b", day: "2026-11-04", user: "Draft a launch tweet for the CRM tool", assistant: "Here is a draft.", keywords: extractKeywords("Draft a launch tweet for the CRM tool") }),
    );

    const hits = await store.relevant("s1", "has Postgres hosting pricing changed since then?");
    assert.equal(hits[0].id, "a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty or corrupt line does not lose the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minimi-"));
  try {
    const store = new MemoryStore(dir);
    await store.append(turn({ id: "a" }));
    const hits = await store.turns("missing-session");
    assert.deepEqual(hits, []);
    assert.equal((await store.turns("s1")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keywords drop stopwords and keep product names", () => {
  const keywords = extractKeywords("Has any of them changed pricing for Neon Postgres since last week?");
  assert.ok(keywords.includes("pricing"));
  assert.ok(keywords.includes("neon"));
  assert.ok(keywords.includes("postgres"));
  assert.ok(!keywords.includes("the"));
});
