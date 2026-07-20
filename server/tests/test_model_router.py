"""Which model answers, and what it is allowed to do.

Dyla's premise is that the local model is the normal case, not the fallback. That
makes two things worth guarding: that a machine without a local model still starts,
and that a local run never spawns subagents — on a small model those derail the work
rather than dividing it.

Run: python -m pytest server/tests/test_model_router.py
"""
import pytest

from server import engine_setup, model_router
from server import models as models_mod
from server.model_router import ModelRouter


@pytest.fixture
def config(monkeypatch):
    """A config with one local profile and one cloud profile, like the real one."""
    cfg = {
        "default_profile": "local",
        "profiles": {
            "local": {
                "label": "Local model",
                "env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:8080"},
                "engine": {"health_url": "http://127.0.0.1:8080/health",
                           "exe": "${LLAMA_SERVER}",
                           # --jinja is not decoration: it is what makes the model
                           # emit tool calls at all.
                           "args": ["-m", "${MODELS_DIR}/model.gguf", "--jinja"]},
            },
            "sonnet": {"label": "Claude Sonnet 5", "model": "claude-sonnet-5"},
        },
    }
    monkeypatch.setattr(model_router, "CONFIG", cfg)
    return cfg


def _with_engine(monkeypatch, tmp_path):
    """Pretends llama-server AND a chosen model are both in place. Both are needed:
    an engine with nothing to load cannot answer, so the profile stays hidden."""
    exe = tmp_path / "llama-server.exe"
    exe.write_text("", encoding="utf-8")
    monkeypatch.setenv("LLAMA_SERVER", str(exe))
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    gguf = tmp_path / "model.gguf"
    gguf.write_text("", encoding="utf-8")
    monkeypatch.setattr(models_mod, "active_path", lambda: str(gguf))


def test_local_is_the_default_when_it_can_run(config, monkeypatch, tmp_path):
    _with_engine(monkeypatch, tmp_path)
    assert ModelRouter().active == "local"


def test_falls_back_when_the_local_model_is_not_set_up(config, monkeypatch):
    """Someone who just cloned Dyla has no GGUF on disk. Starting on a profile that
    cannot run would kill the first message with an obscure error, so we start on
    whatever works and leave the preference in the config."""
    monkeypatch.delenv("LLAMA_SERVER", raising=False)
    monkeypatch.delenv("MODELS_DIR", raising=False)
    r = ModelRouter()
    assert r.active == "sonnet"
    assert "local" not in r.available(), "a profile that cannot run is not offered"


def test_local_profiles_are_recognised_as_local(config, monkeypatch, tmp_path):
    """It is the presence of a local engine that makes a profile local — not its name."""
    _with_engine(monkeypatch, tmp_path)
    r = ModelRouter()
    assert r.is_local("local") is True
    assert r.is_local("sonnet") is False


def test_env_placeholders_are_expanded(config, monkeypatch, tmp_path):
    """The endpoint lives in the config, secrets and paths live in the environment."""
    _with_engine(monkeypatch, tmp_path)
    r = ModelRouter()
    r.active = "local"
    assert r.session_kwargs()["env"]["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8080"


# --- the same model, on three kinds of machine ---

@pytest.fixture
def engine_config(config, monkeypatch):
    """The local profile with per-platform flags, as in the real config.

    The user's chosen context is neutralised here: these tests are about what the
    platform defaults to, and reading the real settings file would make them depend on
    whatever the developer last clicked."""
    monkeypatch.setattr(models_mod, "context_size", lambda default: default)
    config["profiles"]["local"]["engine"]["platform_args"] = {
        "cuda": ["-ngl", "999", "-c", "131072"],
        "metal": ["-ngl", "999", "-c", "65536"],
        "cpu": ["-ngl", "0", "-c", "16384"],
    }
    return config


@pytest.mark.parametrize("system,machine,has_nvidia,expected", [
    ("Windows", "AMD64", True, "cuda"),
    ("Linux", "x86_64", True, "cuda"),
    ("Darwin", "arm64", False, "metal"),
    ("Darwin", "x86_64", False, "cpu"),   # Intel Mac: no Metal worth using
    ("Windows", "AMD64", False, "cpu"),
    ("Linux", "x86_64", False, "cpu"),
])
def test_accelerator_detection(config, monkeypatch, system, machine, has_nvidia, expected):
    monkeypatch.setattr(model_router.platform, "system", lambda: system)
    monkeypatch.setattr(model_router.platform, "machine", lambda: machine)
    monkeypatch.setattr(model_router.shutil, "which",
                        lambda name: "/usr/bin/nvidia-smi" if has_nvidia else None)
    assert ModelRouter().accelerator() == expected


def test_gpu_flags_never_reach_a_machine_without_a_gpu(engine_config, monkeypatch):
    """This is the whole point: -ngl 999 on a machine with no accelerator does not run
    slowly, it fails to start."""
    monkeypatch.setattr(model_router.platform, "system", lambda: "Linux")
    monkeypatch.setattr(model_router.shutil, "which", lambda name: None)
    r = ModelRouter()
    args = r._engine_args(engine_config["profiles"]["local"]["engine"])
    assert "-ngl" in args and args[args.index("-ngl") + 1] == "0"
    assert "131072" not in args, "the full context belongs to the GPU profile"


def test_cpu_gets_a_thread_count_worked_out_here(engine_config, monkeypatch):
    """The right number of threads depends on the machine, so it cannot ship in a
    config file. Two cores are left to the rest of the system."""
    monkeypatch.setattr(model_router.platform, "system", lambda: "Linux")
    monkeypatch.setattr(model_router.shutil, "which", lambda name: None)
    monkeypatch.setattr(model_router.os, "cpu_count", lambda: 8)
    args = ModelRouter()._engine_args(engine_config["profiles"]["local"]["engine"])
    assert args[args.index("-t") + 1] == "6"


def test_apple_silicon_offloads_but_keeps_the_context_smaller(engine_config, monkeypatch):
    """Unified memory: the layers go to the GPU, but the context competes with
    everything else running on the machine."""
    monkeypatch.setattr(model_router.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(model_router.platform, "machine", lambda: "arm64")
    args = ModelRouter()._engine_args(engine_config["profiles"]["local"]["engine"])
    assert args[args.index("-ngl") + 1] == "999"
    assert args[args.index("-c") + 1] == "65536"
    assert "-t" not in args, "thread pinning is for the CPU path only"


def test_shared_flags_survive_on_every_platform(engine_config, monkeypatch):
    """--jinja is what makes tool calling work at all: losing it on one platform would
    break the agent there and nowhere else."""
    for system, machine in (("Windows", "AMD64"), ("Darwin", "arm64"), ("Linux", "x86_64")):
        monkeypatch.setattr(model_router.platform, "system", lambda s=system: s)
        monkeypatch.setattr(model_router.platform, "machine", lambda m=machine: m)
        monkeypatch.setattr(model_router.shutil, "which", lambda name: None)
        args = ModelRouter()._engine_args(engine_config["profiles"]["local"]["engine"])
        assert "--jinja" in args, f"lost on {system}"
        assert "-m" in args, f"lost on {system}"


def test_a_profile_needing_a_missing_variable_is_hidden(config, monkeypatch):
    """Same rule as the engine: if we cannot honour it, we do not offer it."""
    config["profiles"]["gateway"] = {"label": "Gateway",
                                     "env": {"ANTHROPIC_BASE_URL": "${SOME_GATEWAY_URL}"}}
    monkeypatch.delenv("SOME_GATEWAY_URL", raising=False)
    assert "gateway" not in ModelRouter().available()


# --- getting the engine onto a machine that does not have it ---

@pytest.mark.parametrize("system,machine,accel,expected", [
    ("Darwin", "arm64", "metal", "bin-macos-arm64"),
    ("Darwin", "x86_64", "cpu", "bin-macos-x64"),
    ("Windows", "AMD64", "cuda", "bin-win-cuda"),
    ("Windows", "AMD64", "cpu", "bin-win-cpu-x64"),
    ("Windows", "ARM64", "cpu", "bin-win-cpu-arm64"),
    ("Linux", "x86_64", "cpu", "bin-ubuntu-x64"),
])
def test_the_right_build_is_chosen_for_the_machine(monkeypatch, system, machine, accel, expected):
    """Building llama.cpp cannot be the first step of using Dyla, so it downloads the
    binary the project already publishes — but only the one that fits here."""
    monkeypatch.setattr(engine_setup.platform, "system", lambda: system)
    monkeypatch.setattr(engine_setup.platform, "machine", lambda: machine)
    assert engine_setup.asset_pattern(accel) == expected


def test_a_platform_with_no_published_build_says_so(monkeypatch):
    """Better an explanation than a download that silently grabs the wrong binary."""
    assets = [{"name": "llama-b1-bin-macos-arm64.tar.gz"}]
    with pytest.raises(engine_setup.EngineDownloadFailed, match="does not publish"):
        engine_setup._pick_asset(assets, "bin-ubuntu-x64")


def test_the_newest_build_wins_when_several_match():
    """Windows has one build per CUDA version: any works with a current driver, so
    take the latest rather than whichever came first in the list."""
    assets = [{"name": "llama-b1-bin-win-cuda-12.4-x64.zip"},
              {"name": "llama-b1-bin-win-cuda-13.3-x64.zip"}]
    assert "13.3" in engine_setup._pick_asset(assets, "bin-win-cuda")["name"]


def test_your_own_build_wins_over_the_downloaded_one(config, monkeypatch, tmp_path):
    """Someone who compiled llama.cpp for their own hardware tuned it better than a
    generic release: LLAMA_SERVER is checked first."""
    mine = tmp_path / "llama-server.exe"
    mine.write_text("", encoding="utf-8")
    monkeypatch.setenv("LLAMA_SERVER", str(mine))
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(engine_setup, "installed_exe", lambda: tmp_path / "downloaded.exe")
    assert ModelRouter()._engine_exe("local") == str(mine)


def test_the_downloaded_engine_makes_the_profile_usable(config, monkeypatch, tmp_path):
    """No LLAMA_SERVER, but Dyla fetched an engine earlier: the local profile works."""
    monkeypatch.delenv("LLAMA_SERVER", raising=False)
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    downloaded = tmp_path / "llama-server"
    downloaded.write_text("", encoding="utf-8")
    monkeypatch.setattr(engine_setup, "installed_exe", lambda: downloaded)
    gguf = tmp_path / "model.gguf"
    gguf.write_text("", encoding="utf-8")
    monkeypatch.setattr(models_mod, "active_path", lambda: str(gguf))
    r = ModelRouter()
    assert r._engine_exe("local") == str(downloaded)
    assert "local" in r.available()


def test_an_engine_with_no_model_is_not_offered(config, monkeypatch, tmp_path):
    """llama-server installed but nothing chosen to load: the profile would accept the
    switch and then die at the first message, which is the failure we keep designing
    away from."""
    exe = tmp_path / "llama-server.exe"
    exe.write_text("", encoding="utf-8")
    monkeypatch.setenv("LLAMA_SERVER", str(exe))
    monkeypatch.setattr(models_mod, "active_path", lambda: None)
    assert "local" not in ModelRouter().available()


def test_the_chosen_context_overrides_the_platform_default(engine_config, monkeypatch):
    """Context is the setting that decides whether the engine starts at all, and only
    the user knows what else the machine is doing — so their choice wins."""
    monkeypatch.setattr(model_router.platform, "system", lambda: "Windows")
    monkeypatch.setattr(model_router.shutil, "which", lambda n: "nvidia-smi")
    monkeypatch.setattr(models_mod, "context_size", lambda default: 16384)
    args = ModelRouter()._engine_args(engine_config["profiles"]["local"]["engine"])
    assert args[args.index("-c") + 1] == "16384", "the platform default was 131072"


def test_a_dash_c_with_no_value_after_it_is_reported_not_crashed(config, monkeypatch):
    """A hand-edited platform_args ending in a bare "-c" used to raise IndexError
    straight out of this function — the same kind of opaque failure this module exists
    to turn into a clear EngineUnavailable."""
    config["profiles"]["local"]["engine"]["args"] = ["-m", "${MODELS_DIR}/model.gguf", "-c"]
    with pytest.raises(model_router.EngineUnavailable, match="-c"):
        ModelRouter()._engine_args(config["profiles"]["local"]["engine"])


def test_a_dash_c_with_a_non_numeric_value_is_reported_not_crashed(config, monkeypatch):
    config["profiles"]["local"]["engine"]["args"] = [
        "-m", "${MODELS_DIR}/model.gguf", "-c", "not-a-number"]
    with pytest.raises(model_router.EngineUnavailable, match="-c"):
        ModelRouter()._engine_args(config["profiles"]["local"]["engine"])


# --- the llama-server child process: kept, and cleaned up on shutdown ---------------

class _FakePopen:
    def __init__(self):
        self.terminated = False
        self.killed = False
        self._alive = True

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.terminated = True
        self._alive = False

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True
        self._alive = False


def test_ensure_engine_keeps_the_process_and_shutdown_closes_it(config, monkeypatch, tmp_path):
    """Neither the Popen nor its two log files were ever kept anywhere: llama-server (a
    couple of GB once a model is loaded) used to keep running after Dyla itself closed."""
    _with_engine(monkeypatch, tmp_path)
    monkeypatch.setattr(model_router, "RUNTIME_DIR", tmp_path)
    router = ModelRouter()

    fake_proc = _FakePopen()
    monkeypatch.setattr(model_router.subprocess, "Popen", lambda *a, **k: fake_proc)

    calls = {"n": 0}

    def fake_running(self):
        calls["n"] += 1
        return calls["n"] > 1  # not running on the pre-check, running once "started"
    monkeypatch.setattr(ModelRouter, "engine_running", fake_running)

    router.ensure_engine()

    assert router._process is fake_proc
    assert len(router._log_files) == 2
    assert all(not f.closed for f in router._log_files)

    router.shutdown()

    assert fake_proc.terminated
    assert router._process is None
    assert all(f.closed for f in router._log_files)


def test_shutdown_is_a_no_op_when_nothing_was_ever_started(config):
    """A profile that runs the user's own build, launched outside Dyla, is theirs to
    manage — shutdown() must not touch a process it never started."""
    ModelRouter().shutdown()  # must not raise


# --- how much context to try ---

def test_the_advice_matches_what_actually_runs_here():
    """Calibration check against the one setup we have measured: a 17.7 GB model does
    run at 128k inside 23.6 GB of VRAM, so advice that said otherwise would be wrong in
    the only case we can verify."""
    assert models_mod.suggest_context(17.7, 23.6)["try"] == 131072


def test_a_machine_that_cannot_hold_the_model_is_told_so():
    """A 17.7 GB model on a 16 GB machine does not fit at any context: the answer is a
    smaller model, not a smaller context, and the flag says which."""
    advice = models_mod.suggest_context(17.7, 16.0)
    assert advice["tight"] is True


def test_advice_always_names_a_fallback_when_one_exists():
    """The promise is 'start here, drop down if it will not start' — without the second
    number that is just a guess with no recovery."""
    advice = models_mod.suggest_context(7.1, 32.0)
    assert advice["fallback"] is not None and advice["fallback"] < advice["try"]


def test_the_recommended_floor_is_what_claude_code_needs():
    """Dyla drives the model through Claude Code, whose system prompt alone is around
    27k tokens: below 64k the conversation gets compacted almost immediately."""
    assert models_mod.RECOMMENDED_CONTEXT == 65536
    assert min(models_mod.CONTEXT_CHOICES) >= 16384, "8k was never usable here"


def test_a_self_built_engine_counts_as_an_engine(config, monkeypatch, tmp_path):
    """Someone who compiled llama.cpp and set LLAMA_SERVER has an engine. Asking whether
    Dyla downloaded one answers a different question, and answering it instead told
    them to install a second engine while their first one was running."""
    _with_engine(monkeypatch, tmp_path)
    monkeypatch.setattr(engine_setup, "installed_exe", lambda: None)
    assert ModelRouter().engine_ready() is True


def test_the_engine_does_not_disappear_when_you_switch_to_the_cloud(config, monkeypatch, tmp_path):
    """The settings panel asks about the machine, not about the profile in use: with the
    cloud profile selected the local engine is still installed and still running."""
    _with_engine(monkeypatch, tmp_path)
    router = ModelRouter()
    router.active = "sonnet"
    assert router.engine_ready() is True


def test_no_engine_anywhere_is_still_reported_honestly(config, monkeypatch):
    """The download button has to appear for the person who actually needs it."""
    monkeypatch.delenv("LLAMA_SERVER", raising=False)
    monkeypatch.setattr(engine_setup, "installed_exe", lambda: None)
    assert ModelRouter().engine_ready() is False


def test_a_projector_beside_the_model_enables_images(config, monkeypatch, tmp_path):
    """Several models worth running locally are multimodal, but the vision half is a
    separate file. Without it llama-server refuses an image outright, and a screenshot of
    the system being replaced is an ordinary thing to hand this app."""
    _with_engine(monkeypatch, tmp_path)
    (tmp_path / "mmproj-F16.gguf").write_text("", encoding="utf-8")

    args = ModelRouter()._engine_args(config["profiles"]["local"]["engine"])

    assert "--mmproj" in args
    assert args[args.index("--mmproj") + 1].endswith("mmproj-F16.gguf")
    assert "--no-mmproj-offload" in args, "the encoder belongs in RAM: the cards are full"


def test_no_projector_is_not_a_problem(config, monkeypatch, tmp_path):
    """Most people will never download one, and text is the whole job anyway."""
    _with_engine(monkeypatch, tmp_path)
    args = ModelRouter()._engine_args(config["profiles"]["local"]["engine"])
    assert "--mmproj" not in args


def test_the_projector_is_not_mistaken_for_a_model(config, monkeypatch, tmp_path):
    """models.py already hides mmproj files from the model list; this is the other half
    of the same rule — the projector is picked BY name, so a second .gguf sitting in the
    folder is never loaded as one."""
    _with_engine(monkeypatch, tmp_path)
    (tmp_path / "some-other-model.gguf").write_text("", encoding="utf-8")
    (tmp_path / "mmproj-F16.gguf").write_text("", encoding="utf-8")

    args = ModelRouter()._engine_args(config["profiles"]["local"]["engine"])
    assert args[args.index("--mmproj") + 1].endswith("mmproj-F16.gguf")
