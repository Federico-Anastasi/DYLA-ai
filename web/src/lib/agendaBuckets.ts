// Pure logic for the personal agenda: bucket labels and date formatting in a readable form
// ("today", "tomorrow", "Thu 23/07"). No dependency on React or on the backend, so it can be
// tested in isolation (see agendaBuckets.test.ts).
//
// The buckets themselves (what lands in "today" vs "this_week") are computed by the backend —
// here we only read the result, already grouped in AgendaDoc.buckets.
import type { AgendaBucket, AgendaItem } from "../types";

// The order the sections are shown in: whatever it takes to see "where was I", from the most
// urgent to the least, with the finished ones always at the bottom.
export const BUCKET_ORDER: AgendaBucket[] = [
  "overdue",
  "today",
  "tomorrow",
  "this_week",
  "later",
  "undated",
  "done",
];

export const BUCKET_LABEL: Record<AgendaBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  this_week: "This week",
  later: "Later",
  undated: "No date",
  done: "Done",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" -> Date at local midnight. Here the date is a calendar day shown to the
 * user (not a value shared with the backend as in lib/calendar.ts), so we reason in local
 * time rather than UTC. */
function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toLocalISO(today: Date): string {
  return `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
}

function dayDiff(iso: string, today: Date): number {
  const a = fromISO(iso).getTime();
  const b = fromISO(toLocalISO(today)).getTime();
  return Math.round((a - b) / 86400000);
}

/**
 * A date in readable form. `today` is injectable (defaults to now) so the function stays
 * pure and testable without mocking the system clock.
 */
export function formatDate(iso: string | undefined | null, today: Date = new Date()): string {
  if (!iso) return "";
  const diff = dayDiff(iso, today);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  const d = fromISO(iso);
  return `${WEEKDAYS[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

/** A bucket is always shown unless it is empty — "today" is the exception: it stays visible
 * even when empty, with a prompt, because it is the anchor of the day. */
export function showBucket(bucket: AgendaBucket, items: AgendaItem[]): boolean {
  return bucket === "today" || items.length > 0;
}
