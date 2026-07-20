// Estimate totals — pure and testable. Totals are NOT stored in the JSON (see the schema):
// whoever consumes the document computes them every time (the frontend here, the xlsx export
// on the backend).
import type { EstimateDoc, EstimateEpic } from "../types";

export type EpicTotals = { epicId: string; subtotal: number };
export type EstimateTotals = {
  epicSubtotals: EpicTotals[];
  devTotal: number; // the sum of every epic (tasks + e2e)
  e2eTotal: number; // the E2E test share, already inside devTotal
  contingency: number; // rounded to 0.5
  contingencyPct: number;
  grandTotal: number;
};

export function round05(n: number): number {
  return Math.round(n * 2) / 2;
}

export function epicSubtotal(epic: EstimateEpic): number {
  const taskDays = epic.tasks.reduce((sum, t) => sum + (t.days || 0), 0);
  const e2eDays = epic.e2e?.days ?? 0;
  return taskDays + e2eDays;
}

export function computeEstimateTotals(doc: EstimateDoc): EstimateTotals {
  const epicSubtotals = doc.epics.map((e) => ({ epicId: e.id, subtotal: epicSubtotal(e) }));
  const devTotal = epicSubtotals.reduce((sum, e) => sum + e.subtotal, 0);
  const e2eTotal = doc.epics.reduce((sum, e) => sum + (e.e2e?.days ?? 0), 0);
  const pct = doc.meta?.contingency_pct ?? 0;
  const contingency = round05((devTotal * pct) / 100);
  const grandTotal = devTotal + contingency;
  return { epicSubtotals, devTotal, e2eTotal, contingency, contingencyPct: pct, grandTotal };
}

// Sums bottom-up: when task.dev_tasks is not empty, task.days must match this value (a schema
// rule plus a semantic check on the backend, see server/documents.py). Rounded to 2 decimals
// to avoid floating-point artefacts (e.g. 1.1 + 0.2).
export function devTaskSum(task: { dev_tasks: { days: number }[] }): number {
  const sum = task.dev_tasks.reduce((s, d) => s + (d.days || 0), 0);
  return Math.round(sum * 100) / 100;
}
