// Everything here works on civil dates ("2026-11-03"), not instants.
// A question like "what did I ask on 3 November" is a calendar question, so the
// timezone only matters when a stored turn is stamped with its civil date.

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface DayRange {
  from: string;
  to: string;
  label: string;
}

export function civilDate(date: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDays(civil: string, days: number): string {
  const d = new Date(`${civil}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(civil: string): number {
  return new Date(`${civil}T00:00:00Z`).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

function isoDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return "";
  return d.toISOString().slice(0, 10);
}

// recall only ever looks backwards, so a bare "3 November" means the most
// recent 3 November that is not in the future.
function pickYear(day: number, month: number, today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = isoDate(year, month, day);
  if (thisYear && thisYear <= today) return thisYear;
  return isoDate(year - 1, month, day);
}

export function resolveRanges(text: string, today: string): DayRange[] {
  const t = ` ${text.toLowerCase()} `;
  const out: DayRange[] = [];
  const push = (from: string, to = from, label = from) => {
    if (!from) return;
    if (out.some((r) => r.from === from && r.to === to)) return;
    out.push({ from, to, label });
  };

  for (const m of t.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    push(isoDate(Number(m[1]), Number(m[2]), Number(m[3])));
  }

  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/g)) {
    const month = MONTHS[m[2]];
    if (!month) continue;
    push(pickYear(Number(m[1]), month, today));
  }

  for (const m of t.matchAll(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const month = MONTHS[m[1]];
    if (!month) continue;
    push(pickYear(Number(m[2]), month, today));
  }

  if (/\b(day before yesterday)\b/.test(t)) push(addDays(today, -2));
  else if (/\byesterday\b/.test(t)) push(addDays(today, -1));
  if (/\btoday\b|\bjust now\b|\bthis morning\b/.test(t)) push(today);

  for (const m of t.matchAll(/\b(\d{1,2})\s+days?\s+ago\b/g)) {
    push(addDays(today, -Number(m[1])));
  }

  if (/\blast week\b/.test(t)) push(addDays(today, -7), addDays(today, -1), "last week");
  if (/\bthis week\b/.test(t)) {
    const mondayOffset = (weekdayOf(today) + 6) % 7;
    push(addDays(today, -mondayOffset), today, "this week");
  }
  if (/\blast month\b/.test(t)) {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const first = isoDate(year, month - 1, 1) || isoDate(year - 1, 12, 1);
    const last = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
    push(first, last, "last month");
  }

  for (const m of t.matchAll(/\b(last|this|on|since|from)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const prefix = m[1] ?? "";
    const target = WEEKDAYS[m[2]];
    let diff = (weekdayOf(today) - target + 7) % 7;
    // "last Tuesday" said on a Tuesday means a week ago, not today.
    if (prefix === "last" && diff === 0) diff = 7;
    push(addDays(today, -diff));
  }

  return out.sort((a, b) => a.from.localeCompare(b.from));
}

const FRESHNESS =
  /\b(price|pricing|priced|cost|costs|plan|plans|tier|tiers|rate|rates|still|latest|current|currently|now|today|released|release|shipped|launch|launched|update|updated|version|changelog|news|status|available|discontinued|deprecated|acquired|acquisition|outage|down|changed|change|changes)\b/i;

export function isFreshnessSensitive(text: string): boolean {
  return FRESHNESS.test(text);
}

export function looksReferential(text: string): boolean {
  return /\b(it|its|they|them|their|that|those|same|again|since|changed|still)\b/i.test(text);
}
