"""The periodic reminder.

What is being tested is the rhythm, not the words: that it arrives on the first turn (a
conversation that starts wrong stays wrong), that it does not arrive on every message,
and that a long unattended run gets it too. The text itself is prose and will change.

Run: python -m pytest server/tests/test_discipline.py
"""
import pytest

from server import discipline


@pytest.fixture
def chat():
    """One conversation's hook. Each call to hooks() is a new chat with its own count —
    which is the whole point: a chat that has just been opened must start on turn one."""
    return discipline.hooks()["UserPromptSubmit"][0].hooks[0]


async def _turn(chat):
    return await chat({}, None, None)


def _injected(out) -> bool:
    return bool(out) and "REMINDER" in out.get("hookSpecificOutput", {}).get("additionalContext", "")


@pytest.mark.asyncio
async def test_the_first_turn_gets_it(chat):
    """The rules have to be active before the first deliverable, not after the third."""
    assert _injected(await _turn(chat))


@pytest.mark.asyncio
async def test_it_does_not_arrive_every_message(chat):
    """Repeating it constantly is the noise it exists to fight, and it is paid for in
    tokens on every turn."""
    await _turn(chat)
    assert not _injected(await _turn(chat))
    assert not _injected(await _turn(chat))


@pytest.mark.asyncio
async def test_it_comes_back_after_a_few_turns(chat):
    outs = [await _turn(chat) for _ in range(discipline.EVERY_TURNS + 1)]
    assert _injected(outs[0]), "the first turn"
    assert not any(_injected(o) for o in outs[1:-1]), "and then silence in between"
    assert _injected(outs[-1]), "and again once the gap has passed"


@pytest.mark.asyncio
async def test_a_new_chat_starts_fresh():
    """The one that matters. Each chat gets its own counters, so opening a second
    conversation starts it on turn one with the reminder — it does not inherit a count
    from whatever was open before and begin halfway through the cycle, unreminded.

    This is why the counters are closed over per chat instead of living in a table keyed
    by session id: any shared fallback key would be exactly that bug.
    """
    first = discipline.hooks()["UserPromptSubmit"][0].hooks[0]
    second = discipline.hooks()["UserPromptSubmit"][0].hooks[0]

    assert _injected(await first({}, None, None)), "first chat, first turn"
    await first({}, None, None)
    await first({}, None, None)  # first chat is now mid-cycle

    assert _injected(await second({}, None, None)), "the new chat still starts at the top"


@pytest.mark.asyncio
async def test_the_reminder_names_the_web_tools_that_exist(chat):
    """It points at the tools by name, so a rename here that is not mirrored there sends
    the model looking for something that is not on its list."""
    out = await _turn(chat)
    text = out["hookSpecificOutput"]["additionalContext"]
    for name in ("mcp__web__research", "mcp__web__search", "mcp__web__read_url"):
        assert name in text


@pytest.mark.asyncio
async def test_nothing_is_injected_in_the_middle_of_a_turn():
    """There used to be a second hook, firing every twelve tool calls to catch a long
    unattended run. It was removed because of what it cost, which is invisible until you
    read the engine's log: text inserted in the MIDDLE of a conversation invalidates the
    cached prompt from that point on. Three re-prefills of 37-38k tokens in one session,
    141, 145 and 275 seconds, `f_keep = 0.065`.

    On UserPromptSubmit the reminder lands at the end, where the new message is being
    appended anyway, and costs nothing. That is the only hook there should be.
    """
    assert set(discipline.hooks()) == {"UserPromptSubmit"}
