import { describe, expect, it } from "vitest";
import { BUCKET_LABEL, BUCKET_ORDER, formatDate, showBucket } from "./agendaBuckets";
import type { AgendaItem } from "../types";

const TODAY = new Date(2026, 6, 19); // Sunday 19/07/2026

describe("formatDate", () => {
  it("recognises today, tomorrow and yesterday", () => {
    expect(formatDate("2026-07-19", TODAY)).toBe("today");
    expect(formatDate("2026-07-20", TODAY)).toBe("tomorrow");
    expect(formatDate("2026-07-18", TODAY)).toBe("yesterday");
  });

  it("shows weekday + dd/mm for every other date", () => {
    expect(formatDate("2026-07-23", TODAY)).toBe("Thu 23/07");
    expect(formatDate("2026-07-10", TODAY)).toBe("Fri 10/07");
  });

  it("crosses month and year boundaries", () => {
    expect(formatDate("2026-08-01", TODAY)).toBe("Sat 01/08");
    expect(formatDate("2027-01-01", TODAY)).toBe("Fri 01/01");
  });

  it("returns an empty string when the date is missing", () => {
    expect(formatDate(undefined, TODAY)).toBe("");
    expect(formatDate(null, TODAY)).toBe("");
    expect(formatDate("", TODAY)).toBe("");
  });
});

describe("BUCKET_ORDER / BUCKET_LABEL", () => {
  it("goes from the most urgent to the least, with done at the bottom", () => {
    expect(BUCKET_ORDER).toEqual([
      "overdue", "today", "tomorrow", "this_week", "later", "undated", "done",
    ]);
  });

  it("has a label for every bucket", () => {
    for (const b of BUCKET_ORDER) expect(BUCKET_LABEL[b]).toBeTruthy();
    expect(BUCKET_LABEL.overdue).toBe("Overdue");
    expect(BUCKET_LABEL.done).toBe("Done");
  });
});

describe("showBucket", () => {
  const item: AgendaItem = { id: "1", text: "x", status: "open" };

  it("hides an empty bucket", () => {
    expect(showBucket("tomorrow", [])).toBe(false);
    expect(showBucket("overdue", [])).toBe(false);
  });

  it("shows a bucket with at least one item", () => {
    expect(showBucket("tomorrow", [item])).toBe(true);
  });

  it("always shows 'today', even when empty", () => {
    expect(showBucket("today", [])).toBe(true);
    expect(showBucket("today", [item])).toBe(true);
  });
});
