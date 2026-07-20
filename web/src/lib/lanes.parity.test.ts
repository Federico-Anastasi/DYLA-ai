// Checks that the TypeScript engine and its Python twin (server/lanes.py) produce the same
// plan from the same inputs. The two implementations are duplicated out of necessity (the
// board recomputes on every edit without hitting the network, while the xlsx export is a GET
// with no body): this test is what stops them from silently drifting apart.
//
// Both sides read the SAME two fixture files, and the reference plan is regenerated with
// `python -m server.tests.fixtures.generate_plan`. That sharing is the point: while the
// schedule config lived here as a literal, someone could edit one engine's inputs and the
// two would drift while the test stayed green — which is precisely the failure this test
// exists to catch.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { schedule, distribute, reconcile } from "./lanes";
import { extractItems } from "./items";
import type { EstimateDoc, TimelineDoc } from "../types";

const ROOT = resolve(__dirname, "../../..");
const FIXTURES = resolve(ROOT, "server/tests/fixtures");
const ESTIMATE = resolve(FIXTURES, "estimate.json");
const TIMELINE = resolve(FIXTURES, "timeline.json");
const EXPECTED = resolve(FIXTURES, "expected_plan.json");

const READY = existsSync(ESTIMATE) && existsSync(TIMELINE) && existsSync(EXPECTED);

describe("parity with the Python engine", () => {
  it.skipIf(!READY)(
    "produces the same plan from the same fixture",
    () => {
      const estimate = JSON.parse(readFileSync(ESTIMATE, "utf-8")) as EstimateDoc;
      const CONFIG = JSON.parse(readFileSync(TIMELINE, "utf-8")) as TimelineDoc;
      const expected = JSON.parse(readFileSync(EXPECTED, "utf-8"));

      const items = extractItems(estimate);
      const devs = CONFIG.team.map((d) => d.id);
      const lanes = CONFIG.lanes?.length
        ? reconcile(CONFIG.lanes, items, devs)
        : distribute(items, devs);
      const plan = schedule(estimate, CONFIG, lanes);

      // conflict, spanDays and the fractional startOffset/endOffset are the fragile part
      // of the two engines (the ones most likely to silently diverge — a half-day rounding
      // slip, an off-by-one on a straddled weekend, a conflict flag that fires on the wrong
      // side of a layer boundary), yet id/dev/from/to/position were the only fields ever
      // compared here. expected_plan.json (server/tests/fixtures/generate_plan.py) does not
      // serialize them YET — that is server/ scope, out of reach from here — so the extra
      // fields are compared only once the fixture actually carries them, instead of quietly
      // passing on `undefined === undefined` and pretending they're protected.
      const bars = plan.bars.map((b) => ({
        id: b.id,
        dev: b.dev,
        from: b.from,
        to: b.to,
        position: b.position,
        spanDays: b.spanDays,
        startOffset: b.startOffset,
        endOffset: b.endOffset,
        conflict: b.conflict,
      }));
      const fixtureHasExtras = expected.bars.length > 0 && "spanDays" in expected.bars[0];
      if (fixtureHasExtras) {
        expect(bars).toEqual(expected.bars);
      } else {
        expect(bars.map(({ spanDays: _s, startOffset: _so, endOffset: _eo, conflict: _c, ...rest }) => rest))
          .toEqual(expected.bars);
      }
      expect(plan.from).toBe(expected.from);
      expect(plan.to).toBe(expected.to);
      expect(plan.loadPerDev).toEqual(expected.load);

      // unplanned: with this fixture every item is reconciled into some lane, so the correct
      // reference value is the empty list regardless of whether expected_plan.json says so
      // explicitly — this at least catches an item silently falling out of the plan, even
      // though it can't (yet) catch the two engines disagreeing on a genuinely unplanned one.
      const unplannedIds = plan.unplanned.map((i) => i.id).sort();
      expect(unplannedIds).toEqual([...(expected.unplanned ?? [])].sort());
    },
  );
});
