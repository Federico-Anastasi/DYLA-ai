"""Tests for the migration to the multi-chat registry and for token/cost accumulation.

Run with `python -m pytest server/tests`.
"""
import json
import types
from pathlib import Path

import pytest

from server import session_manager as sm


# --- migration from the legacy format (.session.json + .chat.jsonl) -----------

def test_migrate_is_a_noop_when_there_is_nothing_to_migrate(tmp_path: Path):
    assert sm.migrate_legacy_chat(tmp_path) is None
    assert not (tmp_path / sm.CHATS_REGISTRY).exists()


def test_migrate_preserves_the_session_id_and_the_cost(tmp_path: Path):
    (tmp_path / sm.LEGACY_SESSION).write_text(
        json.dumps({"session_id": "abc-123", "profile": "sonnet",
                    "total_cost_usd": 20.123686}),
        encoding="utf-8",
    )
    (tmp_path / sm.LEGACY_CHAT).write_text(
        '{"role": "user", "text": "hello", "ts": 1.0}\n'
        '{"role": "assistant", "segments": [], "ts": 2.0}\n',
        encoding="utf-8",
    )

    registry = sm.migrate_legacy_chat(tmp_path)

    assert registry is not None
    assert registry["active"] == "c1"
    assert len(registry["chats"]) == 1
    chat = registry["chats"][0]
    assert chat["id"] == "c1"
    assert chat["title"] == "Chat 1"
    assert chat["session_id"] == "abc-123"
    assert chat["cost_usd"] == 20.123686
    assert chat["tokens"] == sm._empty_tokens()

    # The old files must not survive: no shims, only the new format gets read.
    assert not (tmp_path / sm.LEGACY_SESSION).exists()
    assert not (tmp_path / sm.LEGACY_CHAT).exists()
    assert (tmp_path / sm.CHATS_REGISTRY).exists()

    moved = (tmp_path / sm.CHATS_DIR / "c1.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(moved) == 2
    assert json.loads(moved[0])["text"] == "hello"

    # The registry written to disk agrees with what was returned.
    on_disk = json.loads((tmp_path / sm.CHATS_REGISTRY).read_text(encoding="utf-8"))
    assert on_disk == registry


def test_migrate_works_even_without_a_chat_jsonl(tmp_path: Path):
    """.session.json with no history (not one line was ever written): the migration must
    not fail."""
    (tmp_path / sm.LEGACY_SESSION).write_text(
        json.dumps({"session_id": "xyz", "total_cost_usd": 0.0}), encoding="utf-8",
    )
    registry = sm.migrate_legacy_chat(tmp_path)
    assert registry["chats"][0]["session_id"] == "xyz"
    assert not (tmp_path / sm.CHATS_DIR / "c1.jsonl").exists()


def test_migration_is_idempotent_through_load_registry(tmp_path: Path, monkeypatch):
    """_load_registry migrates on the first call and then always reads the same file: it
    does not migrate twice."""
    (tmp_path / sm.LEGACY_SESSION).write_text(
        json.dumps({"session_id": "abc", "total_cost_usd": 1.5}), encoding="utf-8",
    )
    monkeypatch.setattr(sm, "PROJECTS_DIR", tmp_path.parent)
    project = tmp_path.name

    first = sm._load_registry(project)
    second = sm._load_registry(project)
    assert first == second
    assert first["chats"][0]["session_id"] == "abc"


def test_load_registry_creates_an_empty_chat_for_a_new_project(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(sm, "PROJECTS_DIR", tmp_path.parent)
    project = tmp_path.name
    registry = sm._load_registry(project)
    assert registry["active"] == "c1"
    assert registry["chats"][0]["title"] == "Chat 1"
    assert registry["chats"][0]["session_id"] is None


# --- chat CRUD ----------------------------------------------------------------

@pytest.fixture
def project(tmp_path: Path, monkeypatch) -> str:
    monkeypatch.setattr(sm, "PROJECTS_DIR", tmp_path)
    d = tmp_path / "demo"
    d.mkdir()
    return "demo"


def test_create_chat_assigns_a_running_id_and_makes_it_active(project):
    first = sm.create_chat(project)   # "c1" already exists (created lazily): this is "c2"
    second = sm.create_chat(project, title="Second")   # "c3"
    registry = sm.list_chats(project)
    assert second["title"] == "Second"
    assert registry["active"] == second["id"]
    assert {c["id"] for c in registry["chats"]} == {"c1", first["id"], second["id"]}
    assert len(registry["chats"]) == 3


def test_delete_chat_refuses_to_remove_the_last_one(project):
    with pytest.raises(ValueError):
        sm.delete_chat(project, "c1")


def test_delete_chat_reassigns_the_active_one_when_needed(project):
    c2 = sm.create_chat(project)  # now active
    sm.delete_chat(project, c2["id"])
    registry = sm.list_chats(project)
    assert registry["active"] == "c1"
    assert len(registry["chats"]) == 1


def test_delete_chat_raises_keyerror_on_an_unknown_id(project):
    sm.create_chat(project)
    with pytest.raises(KeyError):
        sm.delete_chat(project, "does-not-exist")


def test_rename_chat(project):
    sm.rename_chat(project, "c1", "Booking estimate")
    assert sm.list_chats(project)["chats"][0]["title"] == "Booking estimate"


# --- token/cost accumulation --------------------------------------------------

def _fake_result(session_id="11111111-1111-1111-1111-111111111111", cost=1.0, **usage):
    return types.SimpleNamespace(session_id=session_id, total_cost_usd=cost, usage=usage)


def test_accumulate_result_sums_tokens_across_turns(project):
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: False))
    msg1 = _fake_result(cost=1.0, input_tokens=100, output_tokens=50,
                        cache_read_input_tokens=10, cache_creation_input_tokens=5)
    msg2 = _fake_result(cost=2.5, input_tokens=200, output_tokens=80,
                        cache_read_input_tokens=0, cache_creation_input_tokens=20)

    manager._accumulate_result(project, "c1", "sonnet", msg1)
    chat = manager._accumulate_result(project, "c1", "sonnet", msg2)

    assert chat["cost_usd"] == 3.5
    assert chat["tokens"] == {"input": 300, "output": 130, "cache_read": 10, "cache_write": 25}
    assert chat["session_id"] == msg2.session_id


def test_accumulate_result_is_defensive_about_a_partial_usage(project):
    """usage can arrive without some of the keys (different SDK versions): it must not
    blow up."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: False))
    msg = types.SimpleNamespace(session_id="22222222-2222-2222-2222-222222222222",
                                total_cost_usd=0.3, usage={"input_tokens": 10})
    chat = manager._accumulate_result(project, "c1", "sonnet", msg)
    assert chat["tokens"]["input"] == 10
    assert chat["tokens"]["output"] == 0


def test_project_totals_sums_across_every_chat(project):
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: False))
    manager._accumulate_result(project, "c1", "sonnet", _fake_result(cost=1.0, input_tokens=10))
    sm.create_chat(project, title="Second")
    manager._accumulate_result(project, "c2", "sonnet", _fake_result(cost=2.0, input_tokens=20))

    totals = sm.project_totals(project)
    assert totals["cost_usd"] == 3.0
    assert totals["tokens"]["input"] == 30
    assert sm.project_cost(project) == 3.0


def test_a_local_turn_costs_nothing(project):
    """The SDK prices every turn as if it had gone to the API, so a local model that
    costs nothing to run was showing up as ten cents of a bill nobody is sending.
    Tokens keep being counted: those measure the work either way."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    msg = types.SimpleNamespace(
        session_id="33333333-3333-3333-3333-333333333333",
        total_cost_usd=0.42,
        usage={"input_tokens": 100, "output_tokens": 50},
    )
    chat = manager._accumulate_result(project, "c1", "local", msg)
    assert chat["cost_usd"] == 0.0
    assert chat["tokens"]["input"] == 100, "the work still gets measured"


def test_context_tokens_is_the_last_turn_not_the_running_total(project):
    """The two counters answer different questions and only one of them can be compared
    with the context window. A cached prompt is re-sent whole every turn, so the
    cumulative figure passes 128k while the conversation still weighs 20k — reading it
    as 'how full am I' means seeing a chat as nearly out of room when it has barely
    started."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    turn1 = _fake_result(cost=0.0, input_tokens=21000, output_tokens=100,
                         cache_read_input_tokens=0)
    turn2 = _fake_result(cost=0.0, input_tokens=500, output_tokens=20,
                         cache_read_input_tokens=21000)

    manager._accumulate_result(project, "c1", "local", turn1)
    chat = manager._accumulate_result(project, "c1", "local", turn2)

    assert chat["context_tokens"] == 21500, "the prompt of the last turn, cache included"
    assert sum(chat["tokens"].values()) == 42620, "the cumulative counter keeps its meaning"


def test_context_tokens_reads_the_last_call_not_the_turn_total(project):
    """A turn that uses tools is several calls to the model, and the usage on
    ResultMessage adds all of them together. Measured on a real nine-tool turn those
    totals said 126k while the engine was holding 30k — read that way the counter says a
    chat is out of room when it has used a quarter of the window."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    turn_totals = _fake_result(cost=0.0, input_tokens=126000, output_tokens=400)
    last_call = {"input_tokens": 1200, "cache_read_input_tokens": 28564}

    chat = manager._accumulate_result(project, "c1", "local", turn_totals, last_usage=last_call)

    assert chat["context_tokens"] == 29764, "the prompt of the final call, cache included"
    assert chat["tokens"]["input"] == 126000, "the cumulative counter still sees the whole turn"


def test_context_tokens_survives_a_usage_without_cache_fields(project):
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: False))
    msg = types.SimpleNamespace(session_id="44444444-4444-4444-4444-444444444444",
                                total_cost_usd=0.1, usage={"input_tokens": 7})
    chat = manager._accumulate_result(project, "c1", "sonnet", msg)
    assert chat["context_tokens"] == 7


# --- what the model is not carrying ---------------------------------------------

def test_the_heavy_orchestration_tools_are_left_out():
    """A disallowed tool does not enter the prompt at all, and that is the point.

    Measured with a proxy in front of the engine: a turn was carrying 25 tools, 66.5 KB
    of definitions against a 10.7 KB system prompt — `Workflow` alone was 21.3 KB, to
    coordinate subagents in an app whose local profile runs without any. Dropping them
    took the payload to 21.5 KB and a cold turn from 55.6s to 24.4s.
    """
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    off = manager._tools_to_leave_out()
    for tool in ("Workflow", "Task", "ScheduleWakeup", "CronCreate", "EnterWorktree",
                 "NotebookEdit", "ReportFindings"):
        assert tool in off, f"{tool} is dead weight in this app"


def test_the_tools_the_work_needs_are_untouched():
    """The point was never to constrain the model: reading, writing, searching, running
    commands and using skills is the job."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    off = manager._tools_to_leave_out()
    for tool in ("Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill", "WebFetch",
                 "TaskCreate", "TaskUpdate"):
        assert tool not in off, f"{tool} is how the work gets done"


# --- close(): a settings change must not kill a turn in progress ------------------

class _FakeClient:
    def __init__(self):
        self.disconnected = False

    async def disconnect(self):
        self.disconnected = True


@pytest.mark.asyncio
async def test_close_skips_a_session_with_a_turn_in_progress():
    """PUT /api/model and PUT /api/preferences call close() with no arguments on every
    settings change: disconnecting a session mid-turn does not stop the turn, it just
    fails it with an opaque error."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    busy_client, idle_client = _FakeClient(), _FakeClient()
    busy = sm.ProjectSession(client=busy_client, profile="local")
    idle = sm.ProjectSession(client=idle_client, profile="local")
    manager.sessions[("demo", "c1")] = busy
    manager.sessions[("demo", "c2")] = idle
    manager.loaded = ("demo", "c1")

    async with busy.lock:
        await manager.close()

    assert busy_client.disconnected is False, "a turn in progress must survive a settings change"
    assert idle_client.disconnected is True
    assert ("demo", "c1") in manager.sessions, "still there for when the lock frees up"
    assert ("demo", "c2") not in manager.sessions
    assert manager.loaded == ("demo", "c1"), "unchanged: its session never actually closed"


@pytest.mark.asyncio
async def test_close_clears_loaded_once_its_session_actually_closes():
    """self.loaded used to survive a chat's own session being closed, so
    /api/engine/metrics kept pointing at a chat that no longer had one."""
    manager = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    client = _FakeClient()
    manager.sessions[("demo", "c1")] = sm.ProjectSession(client=client, profile="local")
    manager.loaded = ("demo", "c1")

    await manager.close()

    assert client.disconnected is True
    assert manager.loaded is None


def test_the_dead_web_search_goes_only_on_local():
    """The built-in search reaches Anthropic's servers: on a local run it returns nothing
    while still inviting the model to spend a turn calling it. On the cloud profile it
    works, so it stays."""
    local = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: True))
    cloud = sm.SessionManager(router=types.SimpleNamespace(is_local=lambda profile=None: False))
    assert "WebSearch" in local._tools_to_leave_out()
    assert "WebSearch" not in cloud._tools_to_leave_out()
