import { describe, expect, it } from "vitest";
import { computeEstimateTotals, devTaskSum, epicSubtotal, round05 } from "./totals";
import type { EstimateDoc } from "../types";

describe("round05", () => {
  it("rounds to the nearest 0.5", () => {
    expect(round05(1.2)).toBe(1);
    expect(round05(1.26)).toBe(1.5);
    expect(round05(1.76)).toBe(2);
    expect(round05(0)).toBe(0);
  });
});

describe("epicSubtotal", () => {
  it("sums tasks + e2e", () => {
    const subtotal = epicSubtotal({
      id: "E1",
      name: "1. Epic",
      tasks: [
        { id: "E1.T1", task: "A", days: 1.5, description: "", dev_tasks: [] },
        { id: "E1.T2", task: "B", days: 1, description: "", dev_tasks: [] },
      ],
      e2e: { label: "E2E test", days: 0.5 },
    });
    expect(subtotal).toBe(3);
  });

  it("handles a missing e2e row", () => {
    const subtotal = epicSubtotal({
      id: "E1",
      name: "1. Epic",
      tasks: [{ id: "E1.T1", task: "A", days: 0.5, description: "", dev_tasks: [] }],
      e2e: null,
    });
    expect(subtotal).toBe(0.5);
  });
});

describe("devTaskSum", () => {
  it("sums the days of the dev_tasks", () => {
    const task = {
      dev_tasks: [
        { id: "E1.T1.D1", dev_task: "A", description: "", days: 1.5, owner: "" },
        { id: "E1.T1.D2", dev_task: "B", description: "", days: 0.5, owner: "" },
      ],
    };
    expect(devTaskSum(task)).toBe(2);
  });

  it("returns 0 when dev_tasks is empty", () => {
    expect(devTaskSum({ dev_tasks: [] })).toBe(0);
  });

  it("rounds away floating-point artefacts to 2 decimals", () => {
    const task = { dev_tasks: [{ days: 1.1 }, { days: 0.2 }] };
    expect(devTaskSum(task)).toBe(1.3);
  });
});

describe("computeEstimateTotals", () => {
  const doc: EstimateDoc = {
    meta: { project: "demo", title: "Demo", date: "2026-01-01", contingency_pct: 15 },
    epics: [
      {
        id: "E1",
        name: "1. Epic A",
        tasks: [
          { id: "E1.T1", task: "A", days: 3, description: "", dev_tasks: [] },
          { id: "E1.T2", task: "B", days: 1.5, description: "", dev_tasks: [] },
        ],
        e2e: { label: "E2E test A", days: 0.5 },
      },
      {
        id: "E2",
        name: "2. Epic B",
        tasks: [{ id: "E2.T1", task: "C", days: 5, description: "", dev_tasks: [] }],
        e2e: { label: "E2E test B", days: 1 },
      },
    ],
  };

  it("computes subtotals, dev total, contingency and grand total", () => {
    const totals = computeEstimateTotals(doc);
    expect(totals.epicSubtotals).toEqual([
      { epicId: "E1", subtotal: 5 },
      { epicId: "E2", subtotal: 6 },
    ]);
    expect(totals.devTotal).toBe(11);
    // 11 * 15% = 1.65 -> rounded to 0.5 -> 1.5
    expect(totals.contingency).toBe(1.5);
    expect(totals.contingencyPct).toBe(15);
    expect(totals.grandTotal).toBe(12.5);
  });

  it("exposes the E2E share, already inside the dev total", () => {
    const totals = computeEstimateTotals(doc);
    expect(totals.e2eTotal).toBe(1.5); // 0.5 + 1
    expect(totals.e2eTotal).toBeLessThan(totals.devTotal);
  });

  it("e2eTotal is 0 when no epic has a test row", () => {
    const withoutE2e = { ...doc, epics: doc.epics.map((e) => ({ ...e, e2e: null })) };
    expect(computeEstimateTotals(withoutE2e).e2eTotal).toBe(0);
  });

  it("contingency is 0 when the percentage is 0", () => {
    const totals = computeEstimateTotals({ ...doc, meta: { ...doc.meta, contingency_pct: 0 } });
    expect(totals.contingency).toBe(0);
    expect(totals.grandTotal).toBe(totals.devTotal);
  });
});
