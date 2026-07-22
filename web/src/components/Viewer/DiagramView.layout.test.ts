import { describe, expect, it } from "vitest";
import {
  computeRanks,
  computeLayeredAutoPos,
  buildBoxes,
  resolveClusterCollisions,
  layoutGroups,
} from "./DiagramView";
import type { Diagram } from "../../types";

type Box = { x: number; y: number; w: number; h: number };

// True partial intersection on both axes — the overlap the collision pass exists to remove.
// (A box fully containing another also returns true here; the fixture below is built so the
// two group boxes overlap partially, never nest, so this distinguishes fixed from broken.)
function overlaps(a: Box, b: Box): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0;
}

// Two groups whose members each straddle rank 0 and rank 2 around a shared rank-1 hub. Each
// group's padded bounding box therefore spans the full width of the diagram, and the two
// interleave vertically — the same shape that made larkfield's "Cloud host" box swallow its
// neighbours before the layout learned to order by group and resolve collisions. The raw
// layered layout leaves the boxes overlapping; the fix must pull them apart.
const D: Diagram = {
  id: "d",
  kind: "architecture",
  title: "t",
  groups: [
    { id: "gA", label: "Group A" },
    { id: "gB", label: "Group B" },
  ],
  nodes: [
    { id: "a0", label: "A source", class: "actor", group: "gA" },
    { id: "b0", label: "B source", class: "actor", group: "gB" },
    { id: "hub", label: "Hub", class: "backend" },
    { id: "a2", label: "A sink", class: "database", group: "gA" },
    { id: "b2", label: "B sink", class: "storage", group: "gB" },
  ],
  edges: [
    { from: "a0", to: "hub" },
    { from: "b0", to: "hub" },
    { from: "hub", to: "a2" },
    { from: "hub", to: "b2" },
  ],
};

function groupBoxesFor(d: Diagram, resolve: boolean): { gA: Box; gB: Box } {
  const rank = computeRanks(d);
  const auto = computeLayeredAutoPos(d, rank);
  let boxes = buildBoxes(d, auto, null);
  if (resolve) boxes = resolveClusterCollisions(d, boxes, new Set<string>());
  const byId = new Map(layoutGroups(d, boxes).map((g) => [g.group.id, g as Box]));
  return { gA: byId.get("gA")!, gB: byId.get("gB")! };
}

describe("diagram group layout", () => {
  it("the raw layered layout leaves the two group boxes overlapping (guards the fixture)", () => {
    const { gA, gB } = groupBoxesFor(D, false);
    expect(overlaps(gA, gB)).toBe(true);
  });

  it("the collision pass pulls the overlapping group boxes apart", () => {
    const { gA, gB } = groupBoxesFor(D, true);
    expect(overlaps(gA, gB)).toBe(false);
  });
});
