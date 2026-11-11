import assert from "node:assert/strict";
import test from "node:test";
import { addDays, civilDate, isFreshnessSensitive, resolveRanges, weekdayOf } from "../src/time.ts";

// 2026-11-11 is a Wednesday.
const TODAY = "2026-11-11";

test("civil dates are timezone-aware and stable", () => {
  assert.equal(civilDate(new Date("2026-11-11T00:30:00Z"), "Asia/Kolkata"), "2026-11-11");
  assert.equal(civilDate(new Date("2026-11-11T20:00:00Z"), "Asia/Kolkata"), "2026-11-12");
  assert.equal(civilDate(new Date("2026-11-11T20:00:00Z"), "UTC"), "2026-11-11");
  assert.equal(addDays("2026-11-01", -1), "2026-10-31");
  assert.equal(weekdayOf(TODAY), 3);
});

test("resolves the explicit dates people actually type", () => {
  assert.deepEqual(resolveRanges("What did I ask you on 3 November?", TODAY).map((r) => r.from), ["2026-11-03"]);
  assert.deepEqual(resolveRanges("what about 3rd of November", TODAY).map((r) => r.from), ["2026-11-03"]);
  assert.deepEqual(resolveRanges("catch me up on November 3", TODAY).map((r) => r.from), ["2026-11-03"]);
  assert.deepEqual(resolveRanges("remind me about 2026-11-03", TODAY).map((r) => r.from), ["2026-11-03"]);
});

test("a bare month-day looks backwards, never forwards", () => {
  // 25 December has not happened yet in 2026, so the user means 2025.
  assert.deepEqual(resolveRanges("on 25 December you said", TODAY).map((r) => r.from), ["2025-12-25"]);
});

test("resolves relative days and weekdays", () => {
  assert.deepEqual(resolveRanges("yesterday", TODAY).map((r) => r.from), ["2026-11-10"]);
  assert.deepEqual(resolveRanges("what did you say 3 days ago", TODAY).map((r) => r.from), ["2026-11-08"]);
  assert.deepEqual(resolveRanges("last Tuesday I asked about Postgres", TODAY).map((r) => r.from), ["2026-11-10"]);
  assert.deepEqual(resolveRanges("On Monday we shortlisted CRMs", TODAY).map((r) => r.from), ["2026-11-09"]);
});

test("last Tuesday said on a Tuesday means a week ago", () => {
  assert.deepEqual(resolveRanges("last Tuesday", "2026-11-10").map((r) => r.from), ["2026-11-03"]);
});

test("week and month ranges widen correctly", () => {
  const week = resolveRanges("what did we do last week", TODAY)[0];
  assert.deepEqual([week.from, week.to], ["2026-11-04", "2026-11-10"]);

  const month = resolveRanges("last month", TODAY)[0];
  assert.deepEqual([month.from, month.to], ["2026-10-01", "2026-10-31"]);

  const thisWeek = resolveRanges("this week", TODAY)[0];
  assert.deepEqual([thisWeek.from, thisWeek.to], ["2026-11-09", TODAY]);
});

test("freshness detection targets the questions that go stale", () => {
  assert.equal(isFreshnessSensitive("Has any of them changed pricing or shipped something big since?"), true);
  assert.equal(isFreshnessSensitive("Is your answer still correct today?"), true);
  assert.equal(isFreshnessSensitive("What did I ask you on 3 November?"), false);
  assert.equal(isFreshnessSensitive("summarise the design doc I pasted"), false);
});
