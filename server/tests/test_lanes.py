"""Tests for the server-side planning engine.

The scenarios mirror those in web/src/lib/lanes.test.ts: the two implementations are
twins (see the docstring of server/lanes.py) and have to stay in step.
"""

import json
from datetime import date
from pathlib import Path

import pytest

from server import lanes as L

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE_ESTIMATE = json.loads((FIXTURES / "estimate.json").read_text(encoding="utf-8"))
FIXTURE_TIMELINE = json.loads((FIXTURES / "timeline.json").read_text(encoding="utf-8"))
EXPECTED_PLAN = json.loads((FIXTURES / "expected_plan.json").read_text(encoding="utf-8"))

MON = "2026-07-20"  # a Monday
ADA_BOB = [{"id": "ada", "name": "Ada"}, {"id": "bob", "name": "Bob"}]
ADA_ONLY = [{"id": "ada", "name": "Ada"}]


def estimate(dev_tasks):
    return {
        "meta": {"project": "p", "title": "T", "date": MON, "contingency_pct": 15},
        "epics": [{
            "id": "E1", "name": "1. Epic",
            "tasks": [{
                "id": "E1.T1", "task": "T", "description": "",
                "days": sum(d["days"] for d in dev_tasks),
                "dev_tasks": [
                    {"id": d["id"], "dev_task": d["id"], "description": "",
                     "days": d["days"], "layer": d.get("layer", 3)}
                    for d in dev_tasks
                ],
            }],
        }],
    }


def config(team, **extra):
    return {"meta": {"project": "p", "date": MON}, "start_date": MON, "team": team, **extra}


def bar(p, id_):
    return next(b for b in p.bars if b.item.id == id_)


class TestCalendar:
    def test_easter(self):
        assert L.easter(2026) == date(2026, 4, 5)
        assert L.easter(2027) == date(2027, 3, 28)

    def test_monday_from(self):
        assert L.monday_from(date(2026, 7, 20)) == date(2026, 7, 20)
        assert L.monday_from(date(2026, 7, 22)) == date(2026, 7, 27)

    def test_weekends_and_holidays(self):
        cal = L.Calendar()
        assert cal.is_holiday(date(2026, 7, 18))   # Saturday
        assert cal.is_holiday(date(2026, 8, 15))   # mid-August public holiday
        assert not cal.is_holiday(date(2026, 7, 20))

    def test_leave_is_per_developer(self):
        cal = L.Calendar([], [{"id": "ada", "leave": [{"from": MON, "to": "2026-07-24"}]}])
        assert cal.is_on_leave("ada", date(2026, 7, 22))
        assert not cal.is_on_leave("ada", date(2026, 7, 27))
        assert cal.next_workable("ada", date(2026, 7, 20)) == date(2026, 7, 27)


class TestDistribute:
    def test_balances_the_load(self):
        items = L.extract_items(estimate([{"id": f"E1.T1.D{i}", "days": 3} for i in range(1, 5)]))
        lanes = L.distribute(items, ["ada", "bob"])
        assert [len(x["items"]) for x in lanes] == [2, 2]

    def test_lower_layers_go_first(self):
        items = L.extract_items(estimate([
            {"id": "E1.T1.D1", "days": 1, "layer": 3},
            {"id": "E1.T1.D2", "days": 1, "layer": 1},
        ]))
        assert L.distribute(items, ["ada"])[0]["items"] == ["E1.T1.D2", "E1.T1.D1"]

    def test_every_item_placed_exactly_once(self):
        items = L.extract_items(estimate([{"id": f"E1.T1.D{i}", "days": i} for i in range(1, 4)]))
        placed = [i for lane in L.distribute(items, ["ada", "bob"]) for i in lane["items"]]
        assert sorted(placed) == ["E1.T1.D1", "E1.T1.D2", "E1.T1.D3"]

    def test_empty_team(self):
        assert L.distribute(L.extract_items(estimate([{"id": "E1.T1.D1", "days": 1}])), []) == []


class TestReconcile:
    def test_drops_items_that_no_longer_exist(self):
        lanes = L.reconcile(
            [{"dev": "ada", "items": ["E1.T1.D1", "GONE"]}],
            L.extract_items(estimate([{"id": "E1.T1.D1", "days": 1}])), ["ada"])
        assert lanes[0]["items"] == ["E1.T1.D1"]

    def test_appends_new_items_at_the_end(self):
        lanes = L.reconcile(
            [{"dev": "ada", "items": ["E1.T1.D1"]}],
            L.extract_items(estimate([{"id": "E1.T1.D1", "days": 1},
                                      {"id": "E1.T1.D2", "days": 1}])),
            ["ada"])
        assert lanes[0]["items"] == ["E1.T1.D1", "E1.T1.D2"]

    def test_preserves_the_hand_picked_order(self):
        order = ["E1.T1.D3", "E1.T1.D1", "E1.T1.D2"]
        lanes = L.reconcile(
            [{"dev": "ada", "items": order}],
            L.extract_items(estimate([{"id": f"E1.T1.D{i}", "days": 1} for i in range(1, 4)])),
            ["ada"])
        assert lanes[0]["items"] == order

    def test_a_duplicate_dev_keeps_the_first_lane(self):
        """Two lanes for the same developer should not happen, but if timeline.json ever
        has one, the TS twin keeps the first (Array.find semantics) — Python must agree,
        or the same plan assigns an item to a different developer depending on which
        engine computed it."""
        lanes = L.reconcile(
            [{"dev": "ada", "items": ["E1.T1.D1"]},
             {"dev": "ada", "items": ["E1.T1.D2"]}],
            L.extract_items(estimate([{"id": "E1.T1.D1", "days": 1},
                                      {"id": "E1.T1.D2", "days": 1}])),
            ["ada"])
        assert len(lanes) == 1
        # D2 belonged only to the discarded second lane: it comes back as an orphan and
        # gets appended, not silently kept where the duplicate put it.
        assert lanes[0]["items"] == ["E1.T1.D1", "E1.T1.D2"]

    def test_redistributes_the_lane_of_a_departed_developer(self):
        lanes = L.reconcile(
            [{"dev": "ada", "items": ["E1.T1.D1"]}, {"dev": "bob", "items": ["E1.T1.D2"]}],
            L.extract_items(estimate([{"id": "E1.T1.D1", "days": 1},
                                      {"id": "E1.T1.D2", "days": 1}])),
            ["ada"])
        assert len(lanes) == 1
        assert sorted(lanes[0]["items"]) == ["E1.T1.D1", "E1.T1.D2"]


class TestLayout:
    def test_fills_the_capacity_with_no_gaps(self):
        e = estimate([{"id": "E1.T1.D1", "days": 2}, {"id": "E1.T1.D2", "days": 3}])
        p = L.layout(e, config(ADA_ONLY), [{"dev": "ada", "items": ["E1.T1.D1", "E1.T1.D2"]}])
        a, b = p.bars
        assert a.start == date(2026, 7, 20)
        assert b.start == date(2026, 7, 22)   # butted up against the previous one
        assert b.start_offset == 0
        assert b.end == date(2026, 7, 24)     # 5 days = exactly the week

    def test_two_half_days_share_one_day(self):
        e = estimate([{"id": "E1.T1.D1", "days": 0.5}, {"id": "E1.T1.D2", "days": 0.5}])
        p = L.layout(e, config(ADA_ONLY), [{"dev": "ada", "items": ["E1.T1.D1", "E1.T1.D2"]}])
        assert all(b.start == date(2026, 7, 20) and b.end == date(2026, 7, 20) for b in p.bars)
        assert p.bars[1].start_offset == pytest.approx(0.5)

    def test_one_week_is_five_days(self):
        p = L.layout(estimate([{"id": "E1.T1.D1", "days": 5}]), config(ADA_ONLY),
                     [{"dev": "ada", "items": ["E1.T1.D1"]}])
        assert p.bars[0].end == date(2026, 7, 24)

    def test_skips_the_weekend(self):
        p = L.layout(estimate([{"id": "E1.T1.D1", "days": 7}]), config(ADA_ONLY),
                     [{"dev": "ada", "items": ["E1.T1.D1"]}])
        assert p.bars[0].end == date(2026, 7, 28)

    def test_skips_leave(self):
        p = L.layout(
            estimate([{"id": "E1.T1.D1", "days": 2}]),
            config([{"id": "ada", "name": "Ada",
                     "leave": [{"from": MON, "to": "2026-07-22"}]}]),
            [{"dev": "ada", "items": ["E1.T1.D1"]}])
        assert p.bars[0].start == date(2026, 7, 23)

    def test_lanes_run_in_parallel(self):
        e = estimate([{"id": "E1.T1.D1", "days": 2}, {"id": "E1.T1.D2", "days": 2}])
        p = L.layout(e, config(ADA_BOB), [
            {"dev": "ada", "items": ["E1.T1.D1"]}, {"dev": "bob", "items": ["E1.T1.D2"]}])
        assert all(b.start == date(2026, 7, 20) for b in p.bars)

    def test_lane_order_is_calendar_order(self):
        e = estimate([{"id": f"E1.T1.D{i}", "days": 1} for i in range(1, 4)])
        lane = ["E1.T1.D3", "E1.T1.D1", "E1.T1.D2"]
        p = L.layout(e, config(ADA_ONLY), [{"dev": "ada", "items": lane}])
        assert [b.item.id for b in sorted(p.bars, key=lambda b: b.start)] == lane

    def test_load_is_an_exact_sum(self):
        e = estimate([{"id": "E1.T1.D1", "days": 0.25}, {"id": "E1.T1.D2", "days": 1.5}])
        p = L.layout(e, config(ADA_ONLY), [{"dev": "ada", "items": ["E1.T1.D1", "E1.T1.D2"]}])
        assert p.load_per_dev["ada"] == pytest.approx(1.75)

    def test_conflict_when_a_layer_starts_before_the_previous_one_ends(self):
        e = estimate([{"id": "E1.T1.D1", "days": 2, "layer": 1},
                      {"id": "E1.T1.D2", "days": 1, "layer": 2}])
        p = L.layout(e, config(ADA_BOB), [
            {"dev": "ada", "items": ["E1.T1.D1"]}, {"dev": "bob", "items": ["E1.T1.D2"]}])
        assert bar(p, "E1.T1.D2").conflict

    def test_no_conflict_when_the_order_is_respected(self):
        e = estimate([{"id": "E1.T1.D1", "days": 2, "layer": 1},
                      {"id": "E1.T1.D2", "days": 1, "layer": 2}])
        p = L.layout(e, config(ADA_ONLY), [{"dev": "ada", "items": ["E1.T1.D1", "E1.T1.D2"]}])
        assert not any(b.conflict for b in p.bars)

    def test_lists_the_items_left_out_of_the_plan(self):
        e = estimate([{"id": "E1.T1.D1", "days": 1}, {"id": "E1.T1.D2", "days": 1}])
        p = L.layout(e, config(ADA_ONLY), [{"dev": "ada", "items": ["E1.T1.D1"]}])
        assert [v.id for v in p.unplanned] == ["E1.T1.D2"]

    def test_ignores_ids_that_do_not_exist(self):
        p = L.layout(estimate([{"id": "E1.T1.D1", "days": 1}]), config(ADA_ONLY),
                     [{"dev": "ada", "items": ["GHOST", "E1.T1.D1"]}])
        assert len(p.bars) == 1
        assert p.bars[0].start == date(2026, 7, 20)


class TestPlan:
    def test_builds_the_plan_when_there_are_no_lanes(self):
        e = estimate([{"id": "E1.T1.D1", "days": 2}, {"id": "E1.T1.D2", "days": 2}])
        p = L.plan(e, config(ADA_BOB))
        assert len(p.bars) == 2
        assert p.unplanned == []

    def test_honours_the_existing_lanes(self):
        e = estimate([{"id": f"E1.T1.D{i}", "days": 1} for i in range(1, 4)])
        lane = ["E1.T1.D3", "E1.T1.D2", "E1.T1.D1"]
        p = L.plan(e, config(ADA_ONLY, lanes=[{"dev": "ada", "items": lane}]))
        assert [b.item.id for b in sorted(p.bars, key=lambda b: b.start)] == lane

    def test_items_in_a_lane_never_overlap(self):
        e = estimate([{"id": f"E1.T1.D{i}", "days": 1.5} for i in range(1, 5)])
        p = L.plan(e, config(ADA_BOB))
        for dev in ("ada", "bob"):
            theirs = sorted((b for b in p.bars if b.dev == dev), key=lambda b: b.position)
            for before, after in zip(theirs, theirs[1:]):
                assert (after.start > before.end
                        or (after.start == before.end
                            and after.start_offset >= before.end_offset - 1e-6))

    def test_the_total_matches_the_days_in_the_estimate(self):
        e = estimate([{"id": f"E1.T1.D{i}", "days": 1.25} for i in range(1, 6)])
        p = L.plan(e, config(ADA_BOB))
        assert sum(p.load_per_dev.values()) == pytest.approx(6.25)


class TestReferenceFixture:
    """The fixture the TypeScript twin is compared against (see
    web/src/lib/lanes.parity.test.ts). If these expectations move, the reference has to
    be regenerated with `python -m server.tests.fixtures.generate_plan` — otherwise the
    parity test starts comparing the TS engine against a stale plan and passes on a lie.
    """

    def test_the_committed_reference_is_still_what_the_engine_produces(self):
        # The same shape generate_plan.py writes, field for field. It has to stay in step
        # with that script: a field serialised there and not compared here is a field the
        # reference records and nobody checks.
        p = L.plan(FIXTURE_ESTIMATE, FIXTURE_TIMELINE)
        actual = [{"id": b.item.id, "dev": b.dev, "from": b.start.isoformat(),
                   "to": b.end.isoformat(), "position": b.position,
                   "spanDays": b.span_days, "startOffset": b.start_offset,
                   "endOffset": b.end_offset, "conflict": b.conflict} for b in p.bars]
        assert actual == EXPECTED_PLAN["bars"]
        assert p.start.isoformat() == EXPECTED_PLAN["from"]
        assert p.end.isoformat() == EXPECTED_PLAN["to"]
        assert p.load_per_dev == EXPECTED_PLAN["load"]
        assert [it.id for it in p.unplanned] == EXPECTED_PLAN["unplanned"]

    def test_every_estimate_item_is_planned(self):
        """Two items are deliberately missing from the lanes in the fixture, so that
        reconcile() has to find them a developer: none of them may fall off the plan."""
        p = L.plan(FIXTURE_ESTIMATE, FIXTURE_TIMELINE)
        assert p.unplanned == []
        assert len(p.bars) == len(L.extract_items(FIXTURE_ESTIMATE))

    def test_the_company_closure_is_skipped(self):
        """The fixture puts a closure on 2026-09-10, a Thursday: work must jump over it
        rather than schedule a day nobody is there."""
        p = L.plan(FIXTURE_ESTIMATE, FIXTURE_TIMELINE)
        closure = date(2026, 9, 10)
        assert not any(b.start == closure for b in p.bars)

    def test_leave_pushes_the_rest_of_that_lane(self):
        """Chiara is away 14-16 September while her lane is still running: the item after
        the break has to restart on the 17th, and only hers — the other lanes do not move."""
        p = L.plan(FIXTURE_ESTIMATE, FIXTURE_TIMELINE)
        assert bar(p, "E2.T2.D2").start == date(2026, 9, 17)
        assert bar(p, "E2.T1.D4").dev == "d2"
        assert bar(p, "E2.T1.D4").start == date(2026, 9, 14)
