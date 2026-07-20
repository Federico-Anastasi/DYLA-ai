import { describe, expect, it } from "vitest";
import { schedule, distribute, reconcile, moveItem, type Lane } from "./lanes";
import { extractItems } from "./items";
import type { EstimateDoc, TimelineDoc } from "../types";

const MON = "2026-07-20"; // a Monday

function estimate(devTasks: { id: string; days: number; layer?: 1 | 2 | 3 | 4 }[]): EstimateDoc {
  return {
    meta: { project: "p", title: "T", date: MON, contingency_pct: 15 },
    epics: [
      {
        id: "E1",
        name: "1. Epic",
        tasks: [
          {
            id: "E1.T1",
            task: "T",
            days: devTasks.reduce((a, d) => a + d.days, 0),
            description: "",
            dev_tasks: devTasks.map((d) => ({
              id: d.id,
              dev_task: d.id,
              description: "",
              days: d.days,
              layer: d.layer ?? 3,
            })),
          },
        ],
      },
    ],
  };
}

function config(team: TimelineDoc["team"], extra: Partial<TimelineDoc> = {}): TimelineDoc {
  return { meta: { project: "p", date: MON }, start_date: MON, team, ...extra };
}

const ADA_BOB = [
  { id: "ada", name: "Ada" },
  { id: "bob", name: "Bob" },
];

describe("distribute", () => {
  it("balances the load across developers", () => {
    const items = extractItems(estimate([
      { id: "E1.T1.D1", days: 3 },
      { id: "E1.T1.D2", days: 3 },
      { id: "E1.T1.D3", days: 3 },
      { id: "E1.T1.D4", days: 3 },
    ]));
    const lanes = distribute(items, ["ada", "bob"]);
    expect(lanes.map((l) => l.items.length)).toEqual([2, 2]);
  });

  it("puts the lower layers first", () => {
    const items = extractItems(estimate([
      { id: "E1.T1.D1", days: 1, layer: 3 },
      { id: "E1.T1.D2", days: 1, layer: 1 },
    ]));
    const lanes = distribute(items, ["ada"]);
    expect(lanes[0].items).toEqual(["E1.T1.D2", "E1.T1.D1"]);
  });

  it("assigns every item exactly once", () => {
    const items = extractItems(estimate([
      { id: "E1.T1.D1", days: 1 },
      { id: "E1.T1.D2", days: 2 },
      { id: "E1.T1.D3", days: 3 },
    ]));
    const all = distribute(items, ["ada", "bob"]).flatMap((l) => l.items);
    expect(all.sort()).toEqual(["E1.T1.D1", "E1.T1.D2", "E1.T1.D3"]);
  });

  it("survives an empty team", () => {
    expect(distribute(extractItems(estimate([{ id: "E1.T1.D1", days: 1 }])), [])).toEqual([]);
  });

  it("orders ties by plain codepoint, not by locale collation", () => {
    // "EA" < "Ea" in codepoint order (A=65 < a=97) — locale-aware collation ranks case
    // differently depending on the environment's ICU data, which is exactly the
    // machine-to-machine non-determinism this guards against. server/lanes.py sorts with
    // Python's default (ordinal) string comparison, so the two engines only agree if this
    // side also ignores locale.
    const e: EstimateDoc = {
      meta: { project: "p", title: "T", date: MON, contingency_pct: 0 },
      epics: [
        {
          id: "Ea",
          name: "Ea",
          tasks: [{
            id: "Ea.T1", task: "t", days: 1, description: "",
            dev_tasks: [{ id: "Ea.T1.D1", dev_task: "d", description: "", days: 1, layer: 1 }],
          }],
        },
        {
          id: "EA",
          name: "EA",
          tasks: [{
            id: "EA.T1", task: "t", days: 1, description: "",
            dev_tasks: [{ id: "EA.T1.D1", dev_task: "d", description: "", days: 1, layer: 1 }],
          }],
        },
      ],
    };
    const lanes = distribute(extractItems(e), ["ada"]);
    expect(lanes[0].items).toEqual(["EA.T1.D1", "Ea.T1.D1"]);
  });
});

// Drag & drop is this and only this: take out of one array, slot into the other.
describe("moveItem", () => {
  const base: Lane[] = [
    { dev: "ada", items: ["A", "B", "C"] },
    { dev: "bob", items: ["X", "Y"] },
  ];

  it("moves between two queues and shifts the ones behind", () => {
    const lanes = moveItem(base, "B", "bob", 1);
    expect(lanes[0].items).toEqual(["A", "C"]);
    expect(lanes[1].items).toEqual(["X", "B", "Y"]);
  });

  it("inserts at the front", () => {
    expect(moveItem(base, "B", "bob", 0)[1].items).toEqual(["B", "X", "Y"]);
  });

  it("inserts at the back", () => {
    expect(moveItem(base, "B", "bob", 99)[1].items).toEqual(["X", "Y", "B"]);
  });

  it("reorders within the same queue", () => {
    expect(moveItem(base, "C", "ada", 0)[0].items).toEqual(["C", "A", "B"]);
    expect(moveItem(base, "A", "ada", 2)[0].items).toEqual(["B", "C", "A"]);
  });

  it("leaves unrelated queues alone", () => {
    expect(moveItem(base, "B", "bob", 1)[0].items).not.toContain("B");
    expect(moveItem(base, "X", "ada", 0)[1].items).toEqual(["Y"]);
  });

  it("never duplicates the moved item", () => {
    const lanes = moveItem(base, "A", "bob", 1);
    expect(lanes.flatMap((l) => l.items).filter((i) => i === "A")).toHaveLength(1);
  });
});

describe("reconcile", () => {
  it("drops items that disappeared from the estimate", () => {
    const lanes = reconcile(
      [{ dev: "ada", items: ["E1.T1.D1", "GONE"] }],
      extractItems(estimate([{ id: "E1.T1.D1", days: 1 }])),
      ["ada"],
    );
    expect(lanes[0].items).toEqual(["E1.T1.D1"]);
  });

  it("appends brand new items at the back", () => {
    const lanes = reconcile(
      [{ dev: "ada", items: ["E1.T1.D1"] }],
      extractItems(estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }])),
      ["ada"],
    );
    expect(lanes[0].items).toEqual(["E1.T1.D1", "E1.T1.D2"]);
  });

  it("preserves the order chosen by hand", () => {
    const lanes = reconcile(
      [{ dev: "ada", items: ["E1.T1.D3", "E1.T1.D1", "E1.T1.D2"] }],
      extractItems(estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }, { id: "E1.T1.D3", days: 1 }])),
      ["ada"],
    );
    expect(lanes[0].items).toEqual(["E1.T1.D3", "E1.T1.D1", "E1.T1.D2"]);
  });

  it("redistributes the queue of a developer who left", () => {
    const lanes = reconcile(
      [{ dev: "ada", items: ["E1.T1.D1"] }, { dev: "bob", items: ["E1.T1.D2"] }],
      extractItems(estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }])),
      ["ada"],
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0].items.sort()).toEqual(["E1.T1.D1", "E1.T1.D2"]);
  });

  it("creates the queue for a developer who just joined", () => {
    const lanes = reconcile(
      [{ dev: "ada", items: ["E1.T1.D1"] }],
      extractItems(estimate([{ id: "E1.T1.D1", days: 1 }])),
      ["ada", "bob"],
    );
    expect(lanes.map((l) => l.dev)).toEqual(["ada", "bob"]);
    expect(lanes[1].items).toEqual([]);
  });

  it("keeps the FIRST entry when a dev id appears twice in `lanes`", () => {
    // A malformed or hand-edited timeline.json could repeat a dev id, and the two engines
    // must not disagree about which entry wins — the board and the exported spreadsheet
    // would put the same work on different people. Both keep the first: if a developer
    // somehow has two lanes, the first is the one that was there and the rest are the
    // accident. The twin is `setdefault` in server/lanes.py::reconcile.
    const lanes = reconcile(
      [
        { dev: "ada", items: ["E1.T1.D1"] },
        { dev: "ada", items: ["E1.T1.D2"] },
      ],
      extractItems(estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }])),
      ["ada"],
    );
    // D1 comes from the (kept) first entry; D2, orphaned by the discarded second entry,
    // rejoins at the back through the usual homeless-item placement.
    expect(lanes[0].items).toEqual(["E1.T1.D1", "E1.T1.D2"]);
  });
});

// The container has a capacity: one day of work per workable day, five in a full week.
describe("schedule", () => {
  it("fills the capacity with no gaps", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 2 }, { id: "E1.T1.D2", days: 3 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [
      { dev: "ada", items: ["E1.T1.D1", "E1.T1.D2"] },
    ]);
    const [a, b] = plan.bars;
    expect(a.from).toBe(MON);
    // The second one starts exactly where the first ends: no wasted day.
    expect(b.from).toBe("2026-07-22");
    expect(b.startOffset).toBe(0);
    expect(b.to).toBe("2026-07-24"); // 5 days = exactly the week
  });

  it("puts two half days on the same day", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 0.5 }, { id: "E1.T1.D2", days: 0.5 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [
      { dev: "ada", items: ["E1.T1.D1", "E1.T1.D2"] },
    ]);
    expect(plan.bars.every((b) => b.from === MON && b.to === MON)).toBe(true);
    expect(plan.bars[1].startOffset).toBeCloseTo(0.5);
  });

  it("a full week is worth exactly 5 days", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 5 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [{ dev: "ada", items: ["E1.T1.D1"] }]);
    expect(plan.bars[0].to).toBe("2026-07-24"); // Friday
  });

  it("skips the weekend", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 7 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [{ dev: "ada", items: ["E1.T1.D1"] }]);
    expect(plan.bars[0].to).toBe("2026-07-28"); // 5 + 2 past the weekend
  });

  it("skips a single developer's leave", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 2 }]);
    const plan = schedule(
      e,
      config([{ id: "ada", name: "Ada", leave: [{ from: MON, to: "2026-07-22" }] }]),
      [{ dev: "ada", items: ["E1.T1.D1"] }],
    );
    expect(plan.bars[0].from).toBe("2026-07-23");
  });

  it("runs the queues in parallel, each one from the start date", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 2 }, { id: "E1.T1.D2", days: 2 }]);
    const plan = schedule(e, config(ADA_BOB), [
      { dev: "ada", items: ["E1.T1.D1"] },
      { dev: "bob", items: ["E1.T1.D2"] },
    ]);
    expect(plan.bars.every((b) => b.from === MON)).toBe(true);
  });

  it("the queue order is the calendar order", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }, { id: "E1.T1.D3", days: 1 }]);
    const queue = ["E1.T1.D3", "E1.T1.D1", "E1.T1.D2"];
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [{ dev: "ada", items: queue }]);
    expect([...plan.bars].sort((a, b) => a.from.localeCompare(b.from)).map((b) => b.id)).toEqual(queue);
  });

  it("moving an item shifts only the ones behind it in its own queue", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }, { id: "E1.T1.D3", days: 1 }]);
    const cfg = config([{ id: "ada", name: "Ada" }]);
    const before = schedule(e, cfg, [{ dev: "ada", items: ["E1.T1.D1", "E1.T1.D2", "E1.T1.D3"] }]);
    const after = schedule(e, cfg, moveItem([{ dev: "ada", items: ["E1.T1.D1", "E1.T1.D2", "E1.T1.D3"] }], "E1.T1.D3", "ada", 1));
    const at = (p: typeof before, id: string) => p.bars.find((b) => b.id === id)!;
    expect(at(after, "E1.T1.D1").from).toBe(at(before, "E1.T1.D1").from); // unmoved
    expect(at(after, "E1.T1.D3").from < at(before, "E1.T1.D3").from).toBe(true); // pulled forward
    expect(at(after, "E1.T1.D2").from > at(before, "E1.T1.D2").from).toBe(true); // pushed back
  });

  it("the load per queue is the exact sum of the days", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 0.25 }, { id: "E1.T1.D2", days: 1.5 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [
      { dev: "ada", items: ["E1.T1.D1", "E1.T1.D2"] },
    ]);
    expect(plan.loadPerDev.ada).toBeCloseTo(1.75);
  });

  it("flags a conflict when a layer starts before the previous one", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 2, layer: 1 }, { id: "E1.T1.D2", days: 1, layer: 2 }]);
    const plan = schedule(e, config(ADA_BOB), [
      { dev: "ada", items: ["E1.T1.D1"] },
      { dev: "bob", items: ["E1.T1.D2"] }, // layer 2 running alongside layer 1
    ]);
    expect(plan.bars.find((b) => b.id === "E1.T1.D2")!.conflict).toBe(true);
  });

  it("no conflict when the layer order is respected", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 2, layer: 1 }, { id: "E1.T1.D2", days: 1, layer: 2 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [
      { dev: "ada", items: ["E1.T1.D1", "E1.T1.D2"] },
    ]);
    expect(plan.bars.every((b) => !b.conflict)).toBe(true);
  });

  it("lists the items left out of every queue", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 1 }, { id: "E1.T1.D2", days: 1 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [{ dev: "ada", items: ["E1.T1.D1"] }]);
    expect(plan.unplanned.map((i) => i.id)).toEqual(["E1.T1.D2"]);
  });

  it("ignores ids that no longer exist in the estimate", () => {
    const e = estimate([{ id: "E1.T1.D1", days: 1 }]);
    const plan = schedule(e, config([{ id: "ada", name: "Ada" }]), [
      { dev: "ada", items: ["GHOST", "E1.T1.D1"] },
    ]);
    expect(plan.bars).toHaveLength(1);
    expect(plan.bars[0].from).toBe(MON);
  });

  it("an empty project does not break the span", () => {
    const plan = schedule(estimate([]), config([{ id: "ada", name: "Ada" }]), [{ dev: "ada", items: [] }]);
    expect(plan.bars).toHaveLength(0);
    expect(plan.from).toBe(MON);
  });
});

// The property that holds it all together: any sequence of moves must produce a plan where
// every queue is packed and no item goes missing along the way.
describe("invariants", () => {
  const e = estimate([
    { id: "E1.T1.D1", days: 1.5, layer: 1 },
    { id: "E1.T1.D2", days: 0.75, layer: 2 },
    { id: "E1.T1.D3", days: 2, layer: 3 },
    { id: "E1.T1.D4", days: 0.5, layer: 3 },
    { id: "E1.T1.D5", days: 3, layer: 3 },
  ]);
  const items = extractItems(e);
  const cfg = config(ADA_BOB);

  it("after a series of moves no item is lost or duplicated", () => {
    let lanes = distribute(items, ["ada", "bob"]);
    lanes = moveItem(lanes, "E1.T1.D5", "ada", 0);
    lanes = moveItem(lanes, "E1.T1.D1", "bob", 1);
    lanes = moveItem(lanes, "E1.T1.D3", "ada", 2);
    const all = lanes.flatMap((l) => l.items);
    expect(all).toHaveLength(items.length);
    expect(new Set(all).size).toBe(items.length);
  });

  it("the items of one queue never overlap", () => {
    let lanes = distribute(items, ["ada", "bob"]);
    lanes = moveItem(lanes, "E1.T1.D5", "ada", 0);
    const plan = schedule(e, cfg, lanes);
    for (const dev of ["ada", "bob"]) {
      const own = plan.bars.filter((b) => b.dev === dev).sort((a, b) => a.position - b.position);
      for (let i = 1; i < own.length; i++) {
        const prev = own[i - 1];
        const cur = own[i];
        const backToBack =
          cur.from > prev.to ||
          (cur.from === prev.to && cur.startOffset >= prev.endOffset - 1e-6);
        expect(backToBack).toBe(true);
      }
    }
  });

  it("the planned total matches the days in the estimate", () => {
    const lanes = distribute(items, ["ada", "bob"]);
    const plan = schedule(e, cfg, lanes);
    const total = Object.values(plan.loadPerDev).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(items.reduce((a, i) => a + i.days, 0));
    expect(plan.unplanned).toHaveLength(0);
  });
});
