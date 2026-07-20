"""A short reminder, put back into the conversation every few turns.

The rules that matter here are in the system prompt, and on a large cloud model that is
enough. On a small local one it is not: as the conversation grows, instructions read once
at the top get progressively outweighed by everything that came after them. The model
starts answering with tables in the chat, or writing a deliverable without asking the
questions it should have asked. Nothing is wrong with the rules — they are just far away.

A hook does not have that problem. It fires on an event, so it is deterministic, and what
it injects arrives at the bottom of the context where it is being read right now. This is
the same technique Claude Code uses on itself with its system-reminder blocks, and on a
small local model it is the thing that keeps a 35B on task through a long run.

**It only fires when the user speaks.** There used to be a second rhythm — every twelve
tool calls, to catch a long unattended run — and it was expensive in a way that is not
obvious. Text injected in the MIDDLE of a conversation invalidates the engine's cached
prefix from that point on, so everything after it has to be recomputed. Measured in
llama-server's own log: three re-prefills of 37-38k tokens in one session, costing 141,
145 and 275 seconds, with `f_keep = 0.065` — 93% of the prompt thrown away and rebuilt.
A reminder that costs four minutes of silence is worse than the drift it prevents.

On UserPromptSubmit the text lands at the end of the context, right where the engine is
already appending the new message, so it costs nothing extra. That is the only place it
belongs.

It is deliberately short. A long reminder is noise, and noise is what we are fighting.
"""
from __future__ import annotations

from claude_agent_sdk import HookMatcher

# Reinject every this many user turns (1st, 4th, 7th…), tuned on real runs: more often than
# this is nagging, less often and the drift is already there.
EVERY_TURNS = 3

REMINDER = """REMINDER — these are active right now:

1. THE CHAT IS CONVERSATIONAL. Never put an estimate, a data model or a task list in the
   chat as a markdown table. Write the JSON file; the user reads it in the viewer beside
   you. In the chat, talk about it: refer to things by id AND name ("E2.T3, the detail
   view").
2. ASK BEFORE YOU DECIDE. Anything the brief does not settle is a question, not an
   assumption you make quietly. Questions go in a ```questions block, never as free text.
3. NOTHING IS CONFIRMED UNTIL THE USER SAYS SO. Write with meta.status='draft' and leave
   it there; only the user's word moves it to 'confirmed'.
4. FACTS YOU DO NOT HAVE. For anything current, or newer than what you know, search
   instead of recalling: mcp__web__research (searches AND returns the pages, one call),
   mcp__web__search (links), mcp__web__read_url (one page as markdown).
5. SAY WHAT YOU DID, NOT WHAT YOU INTENDED. Before saying a file is written, check that
   it is. An unverified claim costs more than a missing one.
6. BE SHORT. Dense and direct, a few lines, no preamble and no summary of what you are
   about to say."""


class _Counters:
    """Turn and action counts for ONE conversation.

    One of these per chat, held by the chat's own hooks — not a shared table keyed by
    session id. That distinction matters: the SDK's session id is not ours to rely on,
    and any fallback key ("default") would be shared by every chat that hit it, so the
    second chat to open would silently inherit the first one's count and start without
    the reminder. A new chat has to start fresh; the only way to guarantee that is for
    its counters to be new too.

    In memory rather than in a temp file: the hook runs inside the app that owns the chat,
    so there is no separate process that would need a file to share the count across.
    """

    def __init__(self) -> None:
        self.turns = 0

    def user_turn(self) -> bool:
        self.turns += 1
        return self.turns % EVERY_TURNS == 1


def _inject(event: str) -> dict:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": REMINDER}}


def hooks() -> dict:
    """The hook configuration for ClaudeAgentOptions — call it once per chat.

    The counters are closed over here, so each conversation gets its own and a new chat
    begins on turn one, with the reminder.

"""
    counters = _Counters()

    async def on_user_turn(payload, tool_use_id, context) -> dict:
        return _inject("UserPromptSubmit") if counters.user_turn() else {}

    return {
        "UserPromptSubmit": [HookMatcher(hooks=[on_user_turn])],
    }
