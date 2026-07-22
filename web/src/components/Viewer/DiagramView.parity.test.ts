// Checks that the TypeScript diagram layout engine (this file's own computeRanks /
// computeLayeredAutoPos / buildBoxes / resolveClusterCollisions / layoutGroups pipeline)
// and its Python twin (server/diagram_export.py's _rank_layout and friends) agree on the
// layout of the same diagrams. The two are duplicated out of necessity (the viewer
// recomputes on every edit without hitting the network, while the HTML export is a GET
// with no body — see this file's own module docstring): this test is what stops them
// from silently drifting apart, the way they did until the bug fixed in commit 0aa6437
// (the viewer stacking groups instead of laying them out side by side) went unnoticed for
// months.
//
// The two engines use DELIBERATELY DIFFERENT spacing constants (compact screen vs.
// printable export — RANK_GAP_ARCH=90 vs RANK_GAP=190, NODE_GAP=30 vs 36, GROUP_PAD=30 vs
// 20), so this cannot and does not compare absolute coordinates. It compares two
// topological invariants that MUST agree regardless of the constants:
//   1. "order": the sequence of node ids within each rank after the barycenter + group
//      ordering pass (orderWithinRanks / _order_within_ranks).
//   2. "overlaps": which pairs of top-level group boxes truly overlap (positive extent on
//      both axes) once the full layout — including collision resolution — has run. Empty
//      for a well-formed diagram.
//
// Both sides read the SAME diagram.json, and the reference is regenerated with
// `python -m server.tests.fixtures.generate_diagram_layout` (see that generator's
// docstring for why 'sequence' diagrams and swimlane workflows are left out of
// expected_diagram_layout.json — this test only iterates the diagram ids that reference
// actually contains, so it automatically only exercises what the reference computed).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRanks,
  computeLayeredAutoPos,
  buildBoxes,
  layoutGroups,
  resolveClusterCollisions,
  orderWithinRanks,
} from "./DiagramView";
import type { Diagram, DiagramDoc, DiagramGroup } from "../../types";

const ROOT = resolve(__dirname, "../../../..");
const FIXTURES = resolve(ROOT, "server/tests/fixtures");
const DIAGRAM = resolve(FIXTURES, "diagram.json");
const EXPECTED = resolve(FIXTURES, "expected_diagram_layout.json");

const READY = existsSync(DIAGRAM) && existsSync(EXPECTED);

type ExpectedDiagramLayout = {
  diagrams: Record<string, { order: Record<string, string[]>; overlaps: string[][] }>;
  skipped: Record<string, string>;
};

// (overlapX, overlapY); both positive means the two boxes truly overlap — same definition
// used by both engines' own collision-resolution pass (overlapExtent / _box_overlap_extent).
function overlapExtent(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): [number, number] {
  return [
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  ];
}

function isTopLevel(g: DiagramGroup, byId: Map<string, DiagramGroup>): boolean {
  return !g.parent || !byId.has(g.parent);
}

// Runs the same pipeline DiagramView.tsx's render path runs for a free-canvas diagram
// (architecture / dataflow / non-swimlane workflow): rank -> auto-position -> boxes ->
// collision resolution -> group boxes. Mirrors server/diagram_export.py's _rank_layout,
// which folds the same four steps into one function.
function layoutDiagram(diagram: Diagram) {
  const rank = computeRanks(diagram);
  const autoPos = computeLayeredAutoPos(diagram, rank);
  const built = buildBoxes(diagram, autoPos, null);
  const resolved = resolveClusterCollisions(diagram, built, new Set());
  const groupBoxes = layoutGroups(diagram, resolved);
  return { rank, resolved, groupBoxes };
}

function orderInvariant(diagram: Diagram): Record<string, string[]> {
  const rank = computeRanks(diagram);
  const byRank = orderWithinRanks(diagram, rank);
  const out: Record<string, string[]> = {};
  byRank.forEach((ids, r) => {
    out[String(r)] = ids;
  });
  return out;
}

function overlapsInvariant(diagram: Diagram): string[][] {
  const { groupBoxes } = layoutDiagram(diagram);
  const byId = new Map((diagram.groups ?? []).map((g) => [g.id, g]));
  const boxById = new Map(groupBoxes.map((gb) => [gb.group.id, gb]));
  const topLevelIds = (diagram.groups ?? [])
    .filter((g) => isTopLevel(g, byId) && boxById.has(g.id))
    .map((g) => g.id);

  const pairs: string[][] = [];
  for (let i = 0; i < topLevelIds.length; i++) {
    for (let j = i + 1; j < topLevelIds.length; j++) {
      const a = boxById.get(topLevelIds[i])!;
      const b = boxById.get(topLevelIds[j])!;
      const [ox, oy] = overlapExtent(a, b);
      if (ox > 0 && oy > 0) pairs.push([topLevelIds[i], topLevelIds[j]].sort());
    }
  }
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs;
}

describe("parity with the Python diagram layout engine", () => {
  it.skipIf(!READY)(
    "orders nodes within each rank and overlaps top-level group boxes the same way",
    () => {
      const doc = JSON.parse(readFileSync(DIAGRAM, "utf-8")) as DiagramDoc;
      const expected = JSON.parse(readFileSync(EXPECTED, "utf-8")) as ExpectedDiagramLayout;
      const diagramIds = Object.keys(expected.diagrams);

      // The reference is the authority on what's in scope (see this file's header): a
      // sequence diagram or a swimlane workflow simply won't appear as a key here, so
      // there is nothing to skip explicitly on the TS side.
      expect(diagramIds.length).toBeGreaterThan(0);

      for (const diagramId of diagramIds) {
        const diagram = doc.diagrams.find((d) => d.id === diagramId);
        expect(diagram, `fixture diagram '${diagramId}' referenced by expected_diagram_layout.json`).toBeTruthy();
        const exp = expected.diagrams[diagramId];

        expect(orderInvariant(diagram!), `order within ranks for '${diagramId}'`).toEqual(exp.order);
        expect(overlapsInvariant(diagram!), `overlapping top-level group boxes for '${diagramId}'`).toEqual(exp.overlaps);
      }
    },
  );
});
