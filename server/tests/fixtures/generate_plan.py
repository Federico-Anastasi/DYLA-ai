"""Regenerates expected_plan.json, the reference for the parity test between the two
planning engines (server/lanes.py and web/src/lib/lanes.ts).

    python -m server.tests.fixtures.generate_plan

Re-run it whenever the scheduling algorithm changes, or whenever estimate.json /
timeline.json in this folder change.

The inputs are the synthetic fixtures next to this file, NOT a project under projects/:
a public checkout has no projects, and a parity test that silently skips because its
input is missing is a parity test that is not being run. The same two files are what
web/src/lib/lanes.parity.test.ts reads, so neither side gets to drift from the other by
editing a config literal in place.
"""

import json
from pathlib import Path

from server import lanes as planner

HERE = Path(__file__).parent
ESTIMATE = HERE / "estimate.json"
TIMELINE = HERE / "timeline.json"
OUT = HERE / "expected_plan.json"


def main() -> None:
    estimate = json.loads(ESTIMATE.read_text(encoding="utf-8"))
    config = json.loads(TIMELINE.read_text(encoding="utf-8"))
    p = planner.plan(estimate, config)
    OUT.write_text(
        json.dumps(
            {
                # Every field the TypeScript twin also computes, not just the ones that
                # were easy to compare. spanDays, the two offsets and the conflict flag are
                # where the two engines are most likely to drift — half-day boundaries and
                # layer ordering — so leaving them out of the fixture meant the parity test
                # was quietest exactly where it should have been loudest.
                "bars": [
                    {"id": b.item.id, "dev": b.dev, "from": b.start.isoformat(),
                     "to": b.end.isoformat(), "position": b.position,
                     "spanDays": b.span_days, "startOffset": b.start_offset,
                     "endOffset": b.end_offset, "conflict": b.conflict}
                    for b in p.bars
                ],
                "from": p.start.isoformat(),
                "to": p.end.isoformat(),
                "load": p.load_per_dev,
                "unplanned": [it.id for it in p.unplanned],
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    # ASCII only: the Windows console runs on cp1252 and cannot print arrows or em dashes.
    print(f"{len(p.bars)} items, from {p.start} to {p.end}, load {p.load_per_dev}")


if __name__ == "__main__":
    main()
