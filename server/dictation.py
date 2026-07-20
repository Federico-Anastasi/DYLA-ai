"""From speech to a list of things to do (Haiku).

People who dictate do not talk in bullet points: they say three things in a row,
correct themselves, drop a subject, say "Thursday" instead of a date. This module
takes that stream and pulls separate, dated items out of it.

The result is always a PROPOSAL: the interface shows it as a preview and the user
confirms. Nothing is written to the agenda without a person having looked at it.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta

from claude_agent_sdk import ClaudeAgentOptions, query

_SYSTEM = (
    "You turn spoken notes into a list of things to do. "
    "Answer with a JSON array ONLY, no surrounding text and no code fences."
)

_PROMPT = """Today is {today} ({weekday}).

Calendar for the coming days — use THIS to resolve dates, do not compute them:
{calendar}

These are notes dictated out loud by the user. Pull the individual tasks out of them.

Existing projects (use these exact names when a task refers to one of them; if the
user names a piece of work that is not on the list, report the name they used):
{projects}

Rules:
- One item per thing to do. If they said three in a row, that is three items.
- "text": the way they would say it, on one line. Do not rewrite it into officialese.
- "projects": list of project names touched. Empty if the task concerns no project.
  More than one only when the task really does cut across them.
- "due": date as YYYY-MM-DD. Resolve relative dates against today ("tomorrow",
  "Thursday", "end of the month", "next week"). Omit the field if they did not say
  when: do not invent a deadline.
- "time": time of day as HH:MM. It is what orders the day, so propose one whenever the
  task has a date. Rules, in order of precedence:
  1. If they said a time ("at 3", "half past nine"), use it.
  2. If they named a part of the day, use the middle of it:
     morning 09:30 · lunchtime 13:00 · afternoon 14:30 · end of day 17:00
  3. If they only said the day, use 09:30: the morning is when the backlog gets cleared.
  4. If there is no date, omit the time too.
  A task that depends on someone else (call, ask, chase) belongs at a time when that
  person is reachable: never during the lunch hour (13:00-14:00), never so late in the
  day that the answer cannot arrive.
- "priority": "high" only if they used words of urgency (urgent, right away, before
  anything else). Otherwise omit the field.
- "notes": only if they added a detail that does not fit on the line (with whom, what
  is needed, why). Otherwise omit the field.
- If they corrected themselves ("no, actually..."), keep the corrected version.
- Ignore the parts that are not things to do (filler, thinking out loud).

Office hours, so tasks land at a moment when they can actually be done: 9-13 and 14-18.
Outside those hours there is nobody on the other side.

Format of each element:
{{"text": "...", "projects": [], "due": "YYYY-MM-DD", "time": "HH:MM", "priority": "high", "notes": "..."}}

Notes:
---
{text}
---"""

_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _calendar(today: date, days: int = 16) -> str:
    """The next couple of weeks, day by day. Haiku miscounts weekdays ("Thursday"
    comes out as Friday): handing it the list in writing kills the nastiest class of
    error, because a wrong date in a preview does not catch the eye."""
    lines = []
    for i in range(days):
        d = today + timedelta(days=i)
        label = {0: " (today)", 1: " (tomorrow)"}.get(i, "")
        lines.append(f"- {_WEEKDAYS[d.weekday()]} {d.isoformat()}{label}")
    return "\n".join(lines)


def _extract_json(text: str) -> list | None:
    """The model is supposed to answer with just an array. 'Supposed to'."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, list) else None


def _clean(raw: list) -> list[dict]:
    """Keeps only the fields the schema allows, drops whatever is unusable."""
    items = []
    for v in raw:
        if not isinstance(v, dict):
            continue
        text = str(v.get("text") or "").strip()
        if not text:
            continue
        item = {"text": text}
        projects = v.get("projects")
        if isinstance(projects, list):
            item["projects"] = [str(p).strip() for p in projects if str(p).strip()]
        due = str(v.get("due") or "").strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}$", due):
            try:
                date.fromisoformat(due)
                item["due"] = due
            except ValueError:
                pass  # badly invented date: no date beats a wrong one
        time_of_day = str(v.get("time") or "").strip()
        # A time without a day pins nothing: keep it only if the date survived.
        if "due" in item and re.match(r"^([01][0-9]|2[0-3]):[0-5][0-9]$", time_of_day):
            item["time"] = time_of_day
        if v.get("priority") in ("high", "medium", "low"):
            item["priority"] = v["priority"]
        notes = str(v.get("notes") or "").strip()
        if notes:
            item["notes"] = notes
        items.append(item)
    return items


async def structure(text: str, projects: list[str], env: dict | None = None,
                    today: date | None = None) -> list[dict]:
    """Proposed items from the spoken text. Empty list if nothing can be pulled out:
    the interface says so to the user instead of writing junk into the agenda."""
    text = (text or "").strip()
    if not text:
        return []
    today = today or date.today()
    prompt = _PROMPT.format(
        today=today.isoformat(),
        weekday=_WEEKDAYS[today.weekday()],
        calendar=_calendar(today),
        projects="\n".join(f"- {p}" for p in projects) or "(none)",
        text=text,
    )
    options = ClaudeAgentOptions(
        model="claude-haiku-4-5",
        allowed_tools=[],
        max_turns=1,
        system_prompt=_SYSTEM,
        env=dict(env or {}),
    )
    chunks: list[str] = []
    try:
        async for msg in query(prompt=prompt, options=options):
            if type(msg).__name__ == "AssistantMessage":
                for block in msg.content:
                    if type(block).__name__ == "TextBlock":
                        chunks.append(block.text)
    except Exception:
        return []
    raw = _extract_json("".join(chunks))
    return _clean(raw) if raw else []
