"""SessionManager: N SDK chats per project (one session per (project, chat_id)), with
resume and history persisted per chat.

- The SDK client stays connected per (project, chat_id) (a ~1 GiB subprocess each): only a
  handful of concurrent sessions, personal / small-team usage. This is a local app.
- The project chat registry lives in .chats.json (title, session_id, cumulative tokens and
  cost per chat, active chat); per-chat history in .chats/{chat_id}.jsonl -> every chat
  survives restarts and browser changes, and can be read or deleted independently of the
  others.
- One active turn per (project, chat_id) (dedicated lock), interruptible.
- Switching model profile -> sessions are recreated (the SDK env is per session).
- Special project "_global": a quick chat with no project attached (cwd = repo root, sees
  knowledge and every project); its state lives in runtime/global/. It goes through the same
  multi-chat registry, but the UI does not expose the selector for it yet: it always uses the
  first one ("c1").
"""
import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, delete_session, tag_session

from . import discipline
from . import ingest
from . import preferences
from . import project_meta
from . import websearch
from .config import PROJECTS_DIR, ROOT, RUNTIME_DIR
from .model_router import ModelRouter
from .versioning import snapshot

GLOBAL_CHAT = "_global"

# First chat created for a project, both when migrating from the legacy format and for a
# brand new project: a predictable id, which the frontend assumes as a fallback before it has
# loaded the registry (see web/src/store/chatStore.ts).
DEFAULT_CHAT_ID = "c1"

CHATS_REGISTRY = ".chats.json"
CHATS_DIR = ".chats"
LEGACY_SESSION = ".session.json"
LEGACY_CHAT = ".chat.jsonl"

# The skills ask blocking questions and produce structured deliverables (the estimate — with
# dev tasks nested under each task — the data model, the mockup): this append covers both of
# the formats the UI expects.
CHAT_SYSTEM_APPEND = """
## Q&A format for the UI
Clarifying questions to the user ALWAYS go inside a fenced ```questions block (JSON with
clickable options), never as free text. Before writing your first block, read
`.claude/prompts/questions_format.md`: that file is the contract with the UI.

## Deliverables: the chat is ONLY conversational
Never present estimates, dev tasks or data models as markdown tables in the chat. Write or
update the deliverable's JSON file directly (meta.status='draft') — the user sees it in the
viewer next to the chat, not inside your message. In the chat, talk about it conversationally:
refer to elements by id AND name (e.g. "E2.T3, the detail view"): the ids are visible in the
viewer, but on their own they are unreadable. Explain your choices, ask what you need to
finalise. When the user confirms, set meta.status='confirmed'. Quote at most 2-3 lines
verbatim, never the whole table.

The user should not have to type ids, though: each row in the viewer has a chat icon that
sends you the reference already formed (you receive it as [REFERENCE]) together with their
question. When you close a draft asking for confirmation, or when it is unclear which row they
mean, point them at that button instead of making them type an id by hand.

## Citing the brief
When you refer to a specific point of the brief in the chat, write it as [[brief:Chapter
title]]: the UI turns it into a clickable reference that opens the brief and scrolls to it (in
PDFs, to the right page). Use the chapter title exactly as it reads in the document — the UI
takes care of the slug. It is worth citing this way every time you claim "the brief says X":
the reader verifies with one click instead of searching by hand.

## Non-text input documents
PDFs and Word files in the project already have their text extracted under `.extracted/`
(e.g. `.extracted/brief.pdf.md`, `.extracted/docs__flows.pdf.md`): read those, do not try to
open the binary. If a document sits in the folder but has no extract, it is a format we cannot
pull text from: say so to the user instead of silently ignoring it.
"""


def _state_dir(project: str) -> Path:
    if project == GLOBAL_CHAT:
        d = RUNTIME_DIR / "global"
        d.mkdir(parents=True, exist_ok=True)
        return d
    return PROJECTS_DIR / project


# --- chat registry (.chats.json) -------------------------------------------------------------
# A project can have N independent chats (separate SDK sessions, separate history). The
# registry keeps the lightweight metadata (title, tokens, cost) so the UI can populate the
# selector without opening every history jsonl.

def _empty_tokens() -> dict:
    return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}


def _new_chat_entry(chat_id: str, title: str, session_id: str | None = None, cost_usd: float = 0.0) -> dict:
    now = time.time()
    return {
        "id": chat_id,
        "title": title,
        "session_id": session_id,
        "created_ts": now,
        "last_ts": now,
        "tokens": _empty_tokens(),
        # Size of the prompt on the last turn. 0 until the chat has had one.
        "context_tokens": 0,
        "cost_usd": round(cost_usd, 6),
    }


def migrate_legacy_chat(state_dir: Path) -> dict | None:
    """Convert the old format (.session.json + .chat.jsonl, a single chat per project) into the
    new multi-chat registry: session_id and cumulative cost are preserved in chat "c1", the
    history is moved to .chats/c1.jsonl. No compatibility shim: the legacy files are moved or
    deleted right here, and at runtime only the new registry is read. Pure function (all I/O
    confined to state_dir): testable in isolation against a temp directory.

    Returns the registry it created, or None if there was nothing to migrate (project already
    on the new format, or a project with no previous chat at all).
    """
    legacy_session = state_dir / LEGACY_SESSION
    legacy_chat = state_dir / LEGACY_CHAT
    if not legacy_session.exists() and not legacy_chat.exists():
        return None

    old_state = json.loads(legacy_session.read_text(encoding="utf-8")) if legacy_session.exists() else {}
    entry = _new_chat_entry(
        DEFAULT_CHAT_ID, "Chat 1",
        session_id=old_state.get("session_id"),
        cost_usd=old_state.get("total_cost_usd", 0.0),
    )

    chats_dir = state_dir / CHATS_DIR
    chats_dir.mkdir(parents=True, exist_ok=True)
    if legacy_chat.exists():
        legacy_chat.replace(chats_dir / f"{DEFAULT_CHAT_ID}.jsonl")
    if legacy_session.exists():
        legacy_session.unlink()

    registry = {"chats": [entry], "active": DEFAULT_CHAT_ID}
    (state_dir / CHATS_REGISTRY).write_text(json.dumps(registry), encoding="utf-8")
    return registry


def _load_registry(project: str) -> dict:
    """The project's chat registry: migrates the legacy format or creates an empty one on
    first access (idempotent — once .chats.json is written, later calls just read it)."""
    d = _state_dir(project)
    f = d / CHATS_REGISTRY
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    migrated = migrate_legacy_chat(d)
    if migrated is not None:
        return migrated
    registry = {"chats": [_new_chat_entry(DEFAULT_CHAT_ID, "Chat 1")], "active": DEFAULT_CHAT_ID}
    _save_registry(project, registry)
    return registry


def _save_registry(project: str, registry: dict) -> None:
    (_state_dir(project) / CHATS_REGISTRY).write_text(json.dumps(registry), encoding="utf-8")


def _find_chat(registry: dict, chat_id: str) -> dict:
    for c in registry["chats"]:
        if c["id"] == chat_id:
            return c
    raise KeyError(chat_id)


def list_chats(project: str) -> dict:
    """The chat registry as-is (for the UI selector): {"chats": [...], "active": "c1"}."""
    return _load_registry(project)


def create_chat(project: str, title: str | None = None) -> dict:
    registry = _load_registry(project)
    existing_ids = {c["id"] for c in registry["chats"]}
    n = len(registry["chats"]) + 1
    chat_id = f"c{n}"
    while chat_id in existing_ids:  # id already used by a chat deleted earlier
        n += 1
        chat_id = f"c{n}"
    entry = _new_chat_entry(chat_id, title or f"Chat {n}")
    registry["chats"].append(entry)
    registry["active"] = chat_id
    _save_registry(project, registry)
    return entry


def rename_chat(project: str, chat_id: str, title: str) -> dict:
    registry = _load_registry(project)
    chat = _find_chat(registry, chat_id)
    chat["title"] = title
    _save_registry(project, registry)
    return chat


def set_active_chat(project: str, chat_id: str) -> dict:
    registry = _load_registry(project)
    chat = _find_chat(registry, chat_id)
    registry["active"] = chat_id
    _save_registry(project, registry)
    return chat


def delete_chat(project: str, chat_id: str) -> None:
    """Delete the chat: registry entry, history jsonl and SDK session (best effort — if the
    session no longer exists on the SDK side that must not fail the deletion on ours)."""
    registry = _load_registry(project)
    if len(registry["chats"]) <= 1:
        raise ValueError("the last chat of a project cannot be deleted")
    chat = _find_chat(registry, chat_id)
    registry["chats"] = [c for c in registry["chats"] if c["id"] != chat_id]
    if registry["active"] == chat_id:
        registry["active"] = registry["chats"][0]["id"]
    _save_registry(project, registry)

    (_state_dir(project) / CHATS_DIR / f"{chat_id}.jsonl").unlink(missing_ok=True)
    if chat.get("session_id"):
        try:
            delete_session(chat["session_id"], directory=str(ROOT))
        except Exception:
            pass  # SDK session already gone or not deletable: not an error for the user


def project_totals(project: str) -> dict:
    """Sum of tokens and cost across every chat of the project: this is what the UI shows as
    the project total, next to the total of the active chat."""
    registry = _load_registry(project)
    tokens = _empty_tokens()
    cost = 0.0
    for c in registry["chats"]:
        for k in tokens:
            tokens[k] += c.get("tokens", {}).get(k, 0)
        cost += c.get("cost_usd", 0.0)
    return {"tokens": tokens, "cost_usd": round(cost, 6)}


def project_cost(project: str) -> float:
    return project_totals(project)["cost_usd"]


# --- per-chat history (.chats/{chat_id}.jsonl) -----------------------------------------------

def _chat_log_path(project: str, chat_id: str) -> Path:
    d = _state_dir(project) / CHATS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{chat_id}.jsonl"


def load_chat(project: str, chat_id: str, limit: int = 300) -> list[dict]:
    f = _chat_log_path(project, chat_id)
    if not f.exists():
        return []
    lines = f.read_text(encoding="utf-8").splitlines()
    return [json.loads(ln) for ln in lines[-limit:] if ln.strip()]


def _append_chat(project: str, chat_id: str, record: dict) -> None:
    with _chat_log_path(project, chat_id).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


# --- project context ----------------------------------------------------------
# The agent must always know where it is and how far along the project is. Two
# levels, because they have different lifetimes: the project's IDENTITY never
# changes and belongs in the system prompt (frozen at connect time), while the
# STATE of the deliverables changes with every skill run and therefore has to be
# injected on every turn.

# The deliverables whose state is always worth reporting. The others (test plan,
# deck, questions, people) only enter the state line once the project has them:
# listing them as "missing" on every turn would fill each turn with lines that
# say nothing.
DELIVERABLE_FILES = ["data_model.json", "estimate.json", "mockup.json"]
OPTIONAL_DELIVERABLES = ["questions.json", "people.json", "test_plan.json", "deck.json"]


def project_identity(project: str) -> str:
    """The project's identity, for the session's system prompt."""
    if project == GLOBAL_CHAT:
        return ("\n## Where you are\nQuick chat with no project attached: the cwd is the repo "
                "root, projects live under `projects/`. If the user wants to work on a "
                "project, ask which one.\n")
    d = PROJECTS_DIR / project
    ctx = d / "context.md"
    body = ctx.read_text(encoding="utf-8").strip() if ctx.exists() else "(context.md not written yet)"
    source = project_meta.source(d)
    if source == "discovery":
        brief_part = (
            "This project starts from **discovery**: we write the brief ourselves. Meeting "
            "transcripts live in `meetings/`, the brief is the deliverable `brief.json` (updated "
            "with /meeting, exported to Word) and the questions still open are in `questions.json`."
        )
    else:
        brief_part = (
            "This project starts from a **brief we were given**: it is an input document, we do "
            "not rewrite it. If it is a PDF or a Word file, you will find its extracted text "
            "under `.extracted/`."
        )
    return (
        f"\n## Where you are\n"
        f"You are working on the project **{project}**, folder `projects/{project}/`: that is "
        f"where the brief, the documents in `docs/` and every deliverable live. Do not ask the "
        f"user which project this is, nor whether to start from scratch — you already know, and "
        f"the current state of the files is at the top of every message as [PROJECT STATE].\n\n"
        f"{brief_part}\n\n"
        f"### context.md\n{body}\n"
    )


def _status_of(f) -> str:
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("meta", {}).get("status", "")
    except (json.JSONDecodeError, OSError, AttributeError):
        return ""


def deliverables_state(project: str) -> str:
    """State of the deliverables at this turn: for the JSON files what counts is meta.status
    (draft/confirmed), which decides whether we are still discussing or can move on."""
    d = PROJECTS_DIR / project
    parts = []

    brief_json = d / "brief.json"
    brief_input = ingest.brief_file(d)
    if brief_json.is_file():
        parts.append(f"brief.json {_status_of(brief_json) or 'present'}")
    elif brief_input:
        parts.append(f"{brief_input} present")
    else:
        parts.append("brief missing")

    for name in DELIVERABLE_FILES:
        f = d / name
        parts.append(f"{name} {_status_of(f) or 'present'}" if f.exists() else f"{name} missing")
    for name in OPTIONAL_DELIVERABLES:
        f = d / name
        if f.exists():
            parts.append(f"{name} {_status_of(f) or 'present'}")

    for sub in ("docs", "meetings"):
        folder = d / sub
        if folder.is_dir():
            items = sorted(p.name for p in folder.iterdir() if p.is_file())
            if items or sub == "docs":
                parts.append(f"{sub}/ {', '.join(items) if items else 'empty'}")
    return " · ".join(parts)


def build_prompt(prompt: str, anchor: dict | None, state: str | None = None) -> str:
    """Build the prompt actually sent to the SDK, enriched with the state of the
    deliverables and with the reference (anchor) the user is citing from the UI
    (e.g. a row of the estimate table, a table of the data model).

    Pure function: no I/O, testable in isolation.
    """
    head = f"[PROJECT STATE] {state}\n" if state else ""
    if not anchor:
        return head + prompt
    file = anchor.get("file", "")
    ref = anchor.get("ref")
    label = anchor.get("label", "")
    ref_part = f" — element {ref}" if ref else ""
    return (
        f"{head}"
        f"[REFERENCE] The user is citing {file}{ref_part}:\n"
        f"{label}\n"
        f"[REQUEST] {prompt}\n"
        "If the request implies a change to the cited document, update the JSON file "
        "following the schema in schemas/ and summarise what you changed."
    )


@dataclass
class ProjectSession:
    client: ClaudeSDKClient
    profile: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionManager:
    def __init__(self, router: ModelRouter) -> None:
        self.router = router
        # Keyed by (project, chat_id): every chat is an independent SDK session.
        self.sessions: dict[tuple[str, str], ProjectSession] = {}
        # The chat that ran the last turn. The engine holds ONE conversation in its KV
        # cache, and it is this one: continuing here costs seconds, while any other chat
        # pays for its whole prompt again. Without saying which, the context figure in
        # the UI looks like it belongs to whatever the user is currently looking at.
        self.loaded: tuple[str, str] | None = None

    async def _get_session(self, project: str, chat_id: str) -> ProjectSession:
        key = (project, chat_id)
        sess = self.sessions.get(key)
        if sess and sess.profile == self.router.active:
            return sess
        if sess:
            await sess.client.disconnect()
        kw = self.router.session_kwargs()
        registry = _load_registry(project)
        chat = _find_chat(registry, chat_id)
        turned_off = self._tools_to_leave_out()
        options = ClaudeAgentOptions(
            cwd=str(ROOT),
            setting_sources=["project"],
            permission_mode="bypassPermissions",
            include_partial_messages=True,
            system_prompt={"type": "preset", "preset": "claude_code",
                           # The language goes last so it is the final thing read: with
                           # nothing chosen this adds nothing at all, and the agent keeps
                           # answering in whatever language it was written to.
                           "append": (CHAT_SYSTEM_APPEND + project_identity(project)
                                      + preferences.language_instruction())},
            disallowed_tools=turned_off,
            # Our own web search, running inside this process. It replaces the built-in
            # WebSearch, which reaches Anthropic's servers and therefore returns nothing
            # on a local model — see websearch.py. In-process rather than a second
            # runtime: nobody should have to install Node to let the agent read a page.
            mcp_servers={"web": websearch.server()},
            # Only on the local profile. The reminder exists because a small model loses
            # sight of instructions as the context grows; a large one does not, and there
            # it would be tokens spent to repeat what it already follows.
            hooks=discipline.hooks() if self.router.is_local() else None,
            env=kw["env"],
            model=kw["model"],
            resume=chat.get("session_id"),
        )
        client = ClaudeSDKClient(options=options)
        await client.connect()
        sess = ProjectSession(client=client, profile=self.router.active)
        self.sessions[key] = sess
        return sess

    async def chat(self, project: str, chat_id: str, prompt: str, anchor: dict | None = None) -> AsyncIterator[dict]:
        """Run one turn on a specific chat of the project and emit events: delta, tool_use,
        result. `anchor`, when present, is the reference the user is citing from the UI (e.g. a
        row of the estimate): stored as-is in THAT chat's history and used to enrich the prompt
        actually sent to the SDK (see build_prompt).
        """
        sess = await self._get_session(project, chat_id)
        if sess.lock.locked():
            yield {"type": "error", "message": "a turn is already running on this chat"}
            return
        async with sess.lock:
            if project != GLOBAL_CHAT:
                snapshot(project)   # version the key files before the turn touches them
            _append_chat(project, chat_id, {"role": "user", "text": prompt, "anchor": anchor, "ts": time.time()})
            segments: list[dict] = []   # the turn rebuilt for the history log
            text_buf = ""
            # Usage of the LAST call to the model in this turn. A turn that uses tools is
            # several calls, and the one on ResultMessage adds them all up — on a nine-tool
            # turn that came to 126k against a conversation the engine was holding in 30k.
            # The last call is the only one whose prompt IS the current context.
            last_usage: dict = {}
            t0 = time.monotonic()
            state = None if project == GLOBAL_CHAT else deliverables_state(project)
            self.loaded = (project, chat_id)   # from now on the engine is holding this one
            await sess.client.query(build_prompt(prompt, anchor, state))
            async for msg in sess.client.receive_response():
                kind = type(msg).__name__
                if kind == "StreamEvent":
                    ev = msg.event
                    if ev.get("type") == "content_block_delta":
                        text = ev["delta"].get("text")
                        if text:
                            text_buf += text
                            yield {"type": "delta", "text": text}
                elif kind == "AssistantMessage":
                    if getattr(msg, "usage", None):
                        last_usage = msg.usage
                    for block in msg.content:
                        if type(block).__name__ == "ToolUseBlock":
                            preview = _tool_preview(block)
                            if text_buf:
                                segments.append({"type": "text", "text": text_buf})
                                text_buf = ""
                            segments.append({"type": "tool", "name": block.name,
                                             "input": preview})
                            yield {"type": "tool_use", "name": block.name,
                                   "input": preview}
                elif kind == "ResultMessage":
                    if text_buf:
                        segments.append({"type": "text", "text": text_buf})
                    chat_entry = self._accumulate_result(project, chat_id, sess.profile, msg,
                                                        last_usage=last_usage)
                    totals = project_totals(project)
                    result = {
                        "type": "result",
                        "session_id": msg.session_id,
                        "chat_id": chat_id,
                        "cost_usd": 0.0 if self.router.is_local(sess.profile) else msg.total_cost_usd,
                        "chat_cost_usd": chat_entry["cost_usd"],
                        "chat_tokens": chat_entry["tokens"],
                        "chat_context_tokens": chat_entry.get("context_tokens", 0),
                        "project_cost_usd": totals["cost_usd"],
                        "project_tokens": totals["tokens"],
                        "num_turns": msg.num_turns,
                        "duration_s": round(time.monotonic() - t0, 1),
                        "is_error": msg.is_error,
                    }
                    # The same figure the turn was shown with, not the raw SDK one: the
                    # history is what the chat looks like after a reload, and a local turn
                    # that cost nothing must not come back priced like a cloud one.
                    _append_chat(project, chat_id, {"role": "assistant", "segments": segments,
                                                    "cost_usd": result["cost_usd"],
                                                    # Which profile answered. Without it a
                                                    # figure on disk cannot be checked later:
                                                    # a zero could mean "local" or "we lost
                                                    # the number", and nothing tells them apart.
                                                    "profile": sess.profile,
                                                    "duration_s": result["duration_s"],
                                                    "ts": time.time()})
                    yield result

    def _tools_to_leave_out(self) -> list[str]:
        """Tools that are not worth what they cost to carry.

        A disallowed tool is not merely blocked: its definition never enters the prompt.
        That matters more than it sounds. Measured on this app with a proxy in front of
        the engine, one turn arrived carrying 25 tools — 66.5 KB of definitions against a
        10.7 KB system prompt. The tool descriptions were six times the instructions, and
        every one of them is re-sent and re-read on every single turn.

        What comes out is what a local, single-user app that writes documents cannot use:
        orchestration of other agents, scheduling, git worktrees, notebooks. `Workflow`
        alone was 21.3 KB, a third of the whole payload, to coordinate fleets of subagents
        in an app whose local profile deliberately runs without subagents at all.

        Nothing here is disabled to constrain the model — everything it needs to do the
        work (read, write, edit, search, run commands, use skills, keep a todo list) is
        still there.
        """
        # Coordinating other agents. The local profile has no subagents by design: helpers
        # each start from a cold context and the coordination lands on the model least able
        # to pay for it. Without Task, the rest of the machinery has nothing to drive.
        orchestration = ["Task", "Workflow", "SendMessage", "TaskOutput", "TaskStop"]
        # Work that happens while nobody is watching: this app runs when its window is
        # open, and a turn that schedules a wake-up has nothing to wake up into.
        scheduling = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "Monitor"]
        # Dyla writes JSON, spreadsheets and documents inside one project folder. It does
        # not branch, it does not review code, it does not edit notebooks.
        not_this_app = ["EnterWorktree", "ExitWorktree", "ReportFindings", "NotebookEdit"]
        # The built-in web search reaches Anthropic's servers, which a local run cannot
        # do: it does not fail loudly, it just comes back with nothing. Leaving it in
        # costs a definition AND invites the model to call it — we watched a turn spend
        # itself on exactly that. WebFetch stays: it fetches a URL directly.
        dead_on_local = ["WebSearch"] if self.router.is_local() else []
        return orchestration + scheduling + not_this_app + dead_on_local

    def _accumulate_result(self, project: str, chat_id: str, profile: str, msg,
                           last_usage: dict | None = None) -> dict:
        """Update the chat registry with the outcome of the turn: tokens (read defensively from
        usage, because field names can change between SDK versions), cost, session_id
        (discovered on the first turn) and last_ts. Returns the updated chat entry."""
        registry = _load_registry(project)
        chat = _find_chat(registry, chat_id)
        usage = msg.usage or {}
        tokens = chat.setdefault("tokens", _empty_tokens())
        tokens["input"] += usage.get("input_tokens", 0) or 0
        tokens["output"] += usage.get("output_tokens", 0) or 0
        tokens["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
        tokens["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
        # What the conversation weighs RIGHT NOW, which none of the counters above answer:
        # they are cumulative over every turn, and a cached prompt is re-sent whole each
        # time, so the running total grows by the size of the conversation even on a turn
        # that did almost no work. Only this can be compared with the context the engine
        # was loaded with — on a local model, the number that says when the chat stops
        # fitting.
        #
        # It reads the LAST call of the turn, not the totals on ResultMessage: a turn that
        # uses tools is several calls and those totals add every one of them up. Measured
        # on a nine-tool turn, the totals said 126k while the engine was holding 30k.
        prompt_usage = last_usage or usage
        chat["context_tokens"] = ((prompt_usage.get("input_tokens", 0) or 0)
                                  + (prompt_usage.get("cache_read_input_tokens", 0) or 0)
                                  + (prompt_usage.get("cache_creation_input_tokens", 0) or 0))
        # A local model costs nothing to run, but the SDK still prices the turn as if it
        # had gone to the API — a first message came back at ten cents of a bill nobody
        # is sending. Tokens are still counted: those measure the work either way.
        turn_cost = 0.0 if self.router.is_local(profile) else (msg.total_cost_usd or 0.0)
        chat["cost_usd"] = round(chat.get("cost_usd", 0.0) + turn_cost, 6)
        chat["session_id"] = msg.session_id
        chat["last_ts"] = time.time()
        _save_registry(project, registry)
        try:
            # Every SDK session runs with cwd=ROOT: without the tag there would be no way to
            # trace one back to its project (list_sessions(directory=ROOT) would mix them all).
            tag_session(msg.session_id, tag=project, directory=str(ROOT))
        except Exception:
            pass  # tagging is best effort: it must never fail the turn
        return chat

    async def interrupt(self, project: str, chat_id: str) -> bool:
        """Interrupt the turn running on that chat (if any). Returns True if the signal was
        sent."""
        sess = self.sessions.get((project, chat_id))
        if sess and sess.lock.locked():
            await sess.client.interrupt()
            return True
        return False

    async def close(self, project: str | None = None, chat_id: str | None = None) -> None:
        """Close the SDK sessions held in memory. With no arguments it closes everything (e.g.
        on a model switch); with project (and optionally chat_id) it closes only those (e.g. on
        chat deletion).

        A session with a turn in progress is left alone: PUT /api/model and PUT
        /api/preferences call this with no arguments on every settings change, and
        disconnecting out from under a running receive_response() does not stop the turn —
        it just makes it fail with an opaque error. It is picked up next time that chat is
        used, once the lock is free again.
        """
        if project is None:
            targets = list(self.sessions)
        elif chat_id is None:
            targets = [k for k in self.sessions if k[0] == project]
        else:
            targets = [(project, chat_id)] if (project, chat_id) in self.sessions else []
        for key in targets:
            sess = self.sessions.get(key)
            if sess is None or sess.lock.locked():
                continue
            del self.sessions[key]
            await sess.client.disconnect()
            if self.loaded == key:
                # Otherwise /api/engine/metrics keeps offering a link to a chat whose
                # session no longer exists — the case this same field exists to report.
                self.loaded = None


def _tool_preview(block) -> str:
    """Readable summary of the tool input for the UI ("generating the Excel...")."""
    inp = block.input or {}
    for key in ("file_path", "path", "command", "pattern", "prompt", "skill", "description"):
        if key in inp:
            return str(inp[key])[:120]
    return ""
