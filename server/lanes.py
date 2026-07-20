"""The plan as containers: every developer has one ordered lane of items.

TWIN OF `web/src/lib/lanes.ts`. The logic is duplicated on purpose: the board
recalculates on every edit without a network round trip, and the xlsx export is a GET
with no body, so it cannot receive an already-computed plan from the browser. The two
implementations have to stay in step — the tests cover the same scenarios deliberately.

Three clean operations:
    distribute()  fills the lanes from scratch, balancing the load
    reconcile()   realigns the lanes with the current estimate and team
    layout()      lays the lanes out on the calendar

A developer's capacity is one person-day per workable day (5 days in a full week).
Items follow one another with no gaps, even mid-day.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

# Layer assigned to dev tasks generated before the field existed: 3 is the most
# crowded layer and the most conservative one (it does not pull forward work that
# depends on something else).
LAYER_DEFAULT = 3
LAYER_E2E = 4

LAYER_NAMES = {
    1: "Data model",
    2: "Interfaces",
    3: "Logic and integrations",
    4: "E2E tests",
}

EPS = 1e-6

_FIXED_HOLIDAYS = [
    (1, 1), (1, 6), (4, 25), (5, 1), (6, 2), (8, 15), (11, 1), (12, 8), (12, 25), (12, 26),
]


def easter(year: int) -> date:
    """Easter Sunday — Meeus/Jones/Butcher algorithm."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    ll = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ll) // 451
    month, day = divmod(h + ll - 7 * m + 114, 31)
    return date(year, month, day + 1)


def national_holidays(year: int) -> set[date]:
    """National holidays for the year, Easter Monday included."""
    return {date(year, m, d) for m, d in _FIXED_HOLIDAYS} | {easter(year) + timedelta(days=1)}


def monday_from(d: date) -> date:
    """The Monday a project starts on: `d` itself if it already is a Monday, the next
    Monday otherwise. A project always starts at the top of a week."""
    return d + timedelta(days=(7 - d.weekday()) % 7)


class Calendar:
    """Knows whether a day is workable, in general or for a single developer."""

    def __init__(self, extra_holidays: list[dict] | None = None, team: list[dict] | None = None):
        self._extra = {date.fromisoformat(h["date"]) for h in (extra_holidays or [])}
        self._national: dict[int, set[date]] = {}
        self._leave = {
            d["id"]: [
                (date.fromisoformat(p["from"]), date.fromisoformat(p["to"]))
                for p in (d.get("leave") or [])
            ]
            for d in (team or [])
        }

    def _national_for(self, year: int) -> set[date]:
        if year not in self._national:
            self._national[year] = national_holidays(year)
        return self._national[year]

    def is_holiday(self, d: date) -> bool:
        return d.weekday() >= 5 or d in self._extra or d in self._national_for(d.year)

    def is_on_leave(self, dev: str, d: date) -> bool:
        return any(start <= d <= end for start, end in self._leave.get(dev, []))

    def is_workable(self, dev: str, d: date) -> bool:
        return not self.is_holiday(d) and not self.is_on_leave(dev, d)

    def next_workable(self, dev: str, d: date) -> date:
        # The cap (~10 years) avoids an infinite loop if the declared leave covered an
        # absurd range: an out-of-scale date beats a stuck process.
        for _ in range(3660):
            if self.is_workable(dev, d):
                return d
            d += timedelta(days=1)
        return d


@dataclass
class Item:
    id: str
    name: str
    days: float
    layer: int
    epic_id: str
    epic_name: str
    task_id: str | None
    task_name: str | None


@dataclass
class Bar:
    item: Item
    dev: str
    start: date
    end: date
    span_days: int
    position: int
    start_offset: float = 0.0
    end_offset: float = 1.0
    conflict: bool = False


@dataclass
class Plan:
    bars: list[Bar]
    start: date
    end: date
    load_per_dev: dict[str, float]
    unplanned: list[Item] = field(default_factory=list)


def extract_items(estimate: dict) -> list[Item]:
    """Flattens estimate.json into schedulable items: dev tasks plus E2E rows."""
    items: list[Item] = []
    for epic in estimate.get("epics", []):
        for task in epic.get("tasks", []):
            for dt in task.get("dev_tasks") or []:
                items.append(Item(
                    id=dt["id"], name=dt["dev_task"], days=dt["days"],
                    layer=dt.get("layer", LAYER_DEFAULT),
                    epic_id=epic["id"], epic_name=epic["name"],
                    task_id=task["id"], task_name=task["task"],
                ))
        e2e = epic.get("e2e")
        if e2e:
            items.append(Item(
                id=f"{epic['id']}.E2E", name=e2e["label"], days=e2e["days"], layer=LAYER_E2E,
                epic_id=epic["id"], epic_name=epic["name"],
                task_id=None, task_name=None,
            ))
    return items


def distribute(items: list[Item], devs: list[str]) -> list[dict]:
    """Fills the lanes from scratch, balancing the load and respecting the layers.

    This is the only point where the system decides: from here on the lanes belong
    to the user.
    """
    lanes = [{"dev": d, "items": []} for d in devs]
    if not devs:
        return lanes

    load = {d: 0.0 for d in devs}
    for it in sorted(items, key=lambda x: (x.layer, x.epic_id, x.id)):
        chosen = min(range(len(lanes)), key=lambda i: (load[devs[i]], i))
        lanes[chosen]["items"].append(it.id)
        load[devs[chosen]] += it.days
    return lanes


def reconcile(lanes: list[dict], items: list[Item], devs: list[str]) -> list[dict]:
    """Realigns the lanes with the current estimate and team, preserving the order
    picked by hand."""
    days = {it.id: it.days for it in items}
    existing = {it.id for it in items}
    # setdefault, not a dict comprehension: two lanes for the same dev should not happen,
    # but if timeline.json ever carries one (hand-edited, or an older bug), a comprehension
    # would silently keep the LAST one. Both engines keep the FIRST — if a developer somehow
    # has two lanes, the first is the one that was there and the rest are the accident —
    # because otherwise the board and the exported spreadsheet put the same work on
    # different people. The twin is the byDev loop in web/src/lib/lanes.ts::reconcile.
    per_dev: dict[str, list] = {}
    for lane in lanes:
        per_dev.setdefault(lane["dev"], lane["items"])

    out = [
        {"dev": d, "items": [i for i in per_dev.get(d, []) if i in existing]}
        for d in devs
    ]
    if not devs:
        return out

    already = {i for lane in out for i in lane["items"]}
    load = {lane["dev"]: sum(days.get(i, 0) for i in lane["items"]) for lane in out}

    # Homeless items: the new ones, and those that sat on a developer who is gone.
    for it in (x for x in items if x.id not in already):
        chosen = min(range(len(out)), key=lambda i: (load[out[i]["dev"]], i))
        out[chosen]["items"].append(it.id)
        load[out[chosen]["dev"]] += it.days
    return out


def _advance(cal: Calendar, dev: str, day: date, fraction: float, days: float) -> tuple[date, float]:
    """Advances by `days` person-days, skipping the days `dev` cannot work."""
    d = cal.next_workable(dev, day)
    f = fraction
    left = max(days, EPS)  # a 0-day item still takes up an instant

    for _ in range(3660):
        available = 1 - f
        if left <= available + EPS:
            return d, f + left
        left -= available
        d = cal.next_workable(dev, d + timedelta(days=1))
        f = 0.0
    return d, 1.0


def layout(estimate: dict, config: dict, lanes: list[dict]) -> Plan:
    """Lays the lanes out on the calendar: every item starts where the previous one in
    the same lane ended, skipping the days that developer does not work."""
    items = extract_items(estimate)
    by_id = {it.id: it for it in items}
    cal = Calendar(config.get("holidays"), config["team"])
    start = monday_from(date.fromisoformat(config["start_date"]))

    bars: list[Bar] = []
    load: dict[str, float] = {}
    end_of: dict[str, date] = {}

    for lane in lanes:
        dev = lane["dev"]
        day = cal.next_workable(dev, start)
        fraction = 0.0
        load[dev] = 0.0

        for position, item_id in enumerate(lane["items"]):
            it = by_id.get(item_id)
            if it is None:
                continue  # item gone from the estimate: reconciliation will drop it

            begin = (day, fraction)
            end_day, end_fraction = _advance(cal, dev, day, fraction, it.days)

            span = 1
            d = begin[0]
            while d < end_day:
                d = cal.next_workable(dev, d + timedelta(days=1))
                span += 1

            bars.append(Bar(
                item=it, dev=dev, start=begin[0], end=end_day, span_days=span,
                position=position, start_offset=begin[1], end_offset=end_fraction,
            ))
            end_of[it.id] = end_day
            load[dev] += it.days

            # The next item picks up right here: no gaps in the lane.
            if end_fraction >= 1 - EPS:
                day = cal.next_workable(dev, end_day + timedelta(days=1))
                fraction = 0.0
            else:
                day, fraction = end_day, end_fraction

    # A conflict moves nothing: it only flags that the chosen order starts an item
    # before an earlier layer of its epic is closed.
    per_epic: dict[str, list[Item]] = {}
    for it in items:
        per_epic.setdefault(it.epic_id, []).append(it)
    for b in bars:
        b.conflict = any(
            o.id not in end_of or end_of[o.id] > b.start
            for o in per_epic[b.item.epic_id] if o.layer < b.item.layer
        )

    assigned = {b.item.id for b in bars}
    first = min((b.start for b in bars), default=start)
    last = max((b.end for b in bars), default=start)
    return Plan(
        bars=bars, start=first, end=last, load_per_dev=load,
        unplanned=[it for it in items if it.id not in assigned],
    )


def plan(estimate: dict, config: dict) -> Plan:
    """Full plan from estimate + config: reconciles the lanes (or creates them) and
    lays them out."""
    items = extract_items(estimate)
    devs = [d["id"] for d in config["team"]]
    lanes = config.get("lanes")
    lanes = reconcile(lanes, items, devs) if lanes else distribute(items, devs)
    return layout(estimate, config, lanes)
