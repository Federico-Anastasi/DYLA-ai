"""ModelRouter: active model profile -> env/model for the SDK session.

The qwen-local profile starts llama-server if it is down (logic inherited from the
launch script). Its paths come from the LLAMA_SERVER and MODELS_DIR environment
variables: writing them into the config would mean describing one single machine. If
they are missing, the profile is not even offered — better not to see it than to pick
it and get an error.
"""
import os
import platform
import shutil
import string
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import CONFIG, RUNTIME_DIR
from . import engine_setup
from . import models as models_mod


class EngineUnavailable(RuntimeError):
    """The local engine is not installed or not configured on this machine."""


def _expand(value: str, extra: dict | None = None) -> str | None:
    """`${VAR}` -> its value, from the environment plus anything passed in. None when
    something referenced is not defined — the caller decides what that means."""
    try:
        return string.Template(value).substitute({**os.environ, **(extra or {})})
    except KeyError:
        return None


class ModelRouter:
    def __init__(self) -> None:
        # The configured default is the local model, because that is what Dyla is for.
        # On a machine that has not set it up yet the local profile cannot run, and
        # starting on it would mean the first message dies with an obscure error. So we
        # fall back to whatever is usable here — the preference stays in the config, and
        # takes effect as soon as the model is in place.
        wanted = CONFIG["default_profile"]
        self.active: str = wanted if self.usable(wanted) else next(iter(self.available()), wanted)
        # The llama-server child process (if we are the one who started it) and the two
        # log files its stdout/stderr are redirected to. Kept here so `shutdown()` has
        # something to terminate and close instead of leaking a ~GB process and two open
        # handles every time Dyla itself exits.
        self._process: subprocess.Popen | None = None
        self._log_files: list = []

    @property
    def profiles(self) -> dict:
        return CONFIG["profiles"]

    def available(self) -> dict:
        """The profiles that can actually be used here. A profile whose local engine is
        not installed gets hidden: offering it in the menu is a promise we cannot
        keep."""
        return {name: p for name, p in self.profiles.items() if self.usable(name)}

    def is_local(self, name: str | None = None) -> bool:
        """True when the profile runs a model on this machine. A profile that starts a
        local engine is local by definition — that is what `engine` in the config means."""
        return self._engine_cfg(name) is not None

    def usable(self, name: str) -> bool:
        """A profile counts only if everything it needs is really here: the environment
        variables its `env` refers to, and — when it runs a model locally — the engine
        executable itself."""
        p = self.profiles[name] or {}
        for value in (p.get("env") or {}).values():
            if _expand(str(value)) is None:
                return False
        if not self._engine_cfg(name):
            return True
        # An engine with no model to load is a profile that cannot answer: hide it
        # until the settings have one, rather than fail at the first message.
        return self._engine_exe(name) is not None and models_mod.active_path() is not None

    def set_active(self, name: str) -> None:
        if name not in self.profiles:
            raise ValueError(f"unknown profile: {name}")
        if not self.usable(name):
            raise EngineUnavailable(
                f"profile '{name}' requires llama-server: set the LLAMA_SERVER and "
                "MODELS_DIR environment variables and restart the app")
        self.active = name
        self.ensure_engine()

    def session_kwargs(self) -> dict:
        """env and model to pass to ClaudeAgentOptions for the active profile."""
        p = self.profiles[self.active] or {}
        return {"env": dict(p.get("env") or {}), "model": p.get("model")}

    # --- local engine (llama-server) ---

    def _engine_cfg(self, name: str | None = None) -> dict | None:
        return (self.profiles[name or self.active] or {}).get("engine")

    def _engine_exe(self, name: str | None = None) -> str | None:
        """Path of the local engine executable, or None if there is none yet.

        Two places, in order: the build the user pointed LLAMA_SERVER at — theirs is
        almost certainly better tuned than a generic one — and otherwise the build
        Dyla downloaded into runtime/. Nothing here downloads anything; that is
        `install_engine`, because it costs bandwidth and has to be asked for."""
        cfg = self._engine_cfg(name)
        if not cfg:
            return None
        exe = _expand(str(cfg.get("exe") or ""))
        if exe and Path(exe).is_file():
            return exe
        downloaded = engine_setup.installed_exe()
        return str(downloaded) if downloaded else None

    def install_engine(self, progress=None) -> str:
        """Fetches the prebuilt llama-server for this machine. Returns its path."""
        return str(engine_setup.install(self.accelerator(), progress))

    def engine_ready(self, name: str | None = None) -> bool:
        """Whether there is an engine we can actually run here.

        Not the same question as "did Dyla download one": someone who built llama.cpp
        themselves and set LLAMA_SERVER has an engine, and asking them to install a
        second one — or telling them the engine is missing while it is running — is
        wrong. Anything that reports engine state to the user asks this, not
        engine_setup.installed_exe().

        With no argument it answers for the machine rather than for the active profile:
        the settings panel asks this while the cloud profile is selected, and the engine
        does not stop existing because you switched away from it."""
        if name is not None:
            return self._engine_exe(name) is not None
        return any(self._engine_exe(p) is not None
                   for p, cfg in self.profiles.items() if (cfg or {}).get("engine"))

    def accelerator(self) -> str:
        """What this machine can offload the model onto: "cuda", "metal" or "cpu".

        The distinction matters because the same flags that make llama-server fly on a
        GPU rig make it fail to start on a laptop: asking for 999 layers on a machine
        with no accelerator is not slow, it is an error."""
        if platform.system() == "Darwin" and platform.machine() == "arm64":
            return "metal"  # every Apple Silicon Mac has it, no probing needed
        if shutil.which("nvidia-smi"):
            return "cuda"
        return "cpu"

    def _engine_args(self, cfg: dict) -> list[str]:
        """The command line for this machine: the shared flags plus the ones for the
        accelerator we actually have."""
        args = list(cfg.get("args") or [])
        per_platform = cfg.get("platform_args") or {}
        extra = per_platform.get(self.accelerator())
        if extra is None:
            extra = per_platform.get("cpu", [])
        args += list(extra)
        # On CPU the sensible thread count depends on the machine, so it cannot be
        # written in a config file that ships to everyone. Leave two cores for the rest
        # of the system — including this backend, which has to keep answering.
        if self.accelerator() == "cpu" and "-t" not in args:
            args += ["-t", str(max(1, (os.cpu_count() or 4) - 2))]
        # The user's context wins over the platform default: only they know what else
        # this machine is doing, and getting it wrong means the engine will not start.
        if "-c" in args:
            i = args.index("-c")
            # A hand-edited platform_args with "-c" as its last flag, or with something
            # that is not a number after it, used to raise IndexError/ValueError straight
            # out of ensure_engine — the same "opaque 500" this module exists to avoid.
            if i + 1 >= len(args) or not args[i + 1].lstrip("-").isdigit():
                raise EngineUnavailable(
                    "the engine config's '-c' flag has no numeric value after it — "
                    "check platform_args in server/config.yaml")
            args[i + 1] = str(models_mod.context_size(int(args[i + 1])))
        args += self._vision_args()
        return args

    def _vision_args(self) -> list[str]:
        """Flags that let the model accept images, when the model can.

        Several of the models worth running locally are natively multimodal, but the
        vision half lives in a separate projector file next to the weights. Without it
        llama-server refuses an image outright ("image input is not supported"), and a
        screenshot of the system being replaced — or a photo of a whiteboard after a
        meeting — is an ordinary thing to hand this app. So: if a projector is sitting
        beside the chosen model, load it; if not, carry on without.

        It stays out of VRAM deliberately. On a machine where the model and its context
        already fill the cards, putting another gigabyte on them is how the engine fails
        to start — and encoding an image is occasional, so paying for it on the CPU is
        the right trade.
        """
        model = models_mod.active_path()
        if not model:
            return []
        projector = next((p for p in sorted(Path(model).parent.glob("*.gguf"))
                          if "mmproj" in p.name.lower()), None)
        if not projector:
            return []
        # --image-min-tokens: the engine asks for it by name in its own startup log
        # ("if you encounter problems with accuracy, try adding --image-min-tokens 1024").
        # Screenshots of dense interfaces are the case that needs it: at the default
        # resolution the model reads the layout but not the words in it.
        return ["--mmproj", str(projector), "--no-mmproj-offload",
                "--image-min-tokens", "1024"]

    def engine_running(self) -> bool:
        cfg = self._engine_cfg()
        if not cfg:
            return False
        try:
            with urllib.request.urlopen(cfg["health_url"], timeout=2) as r:
                return r.status == 200
        except (urllib.error.URLError, OSError):
            return False

    def ensure_engine(self, timeout_s: int = 90) -> None:
        """Starts llama-server if the active profile needs it and it is not answering."""
        cfg = self._engine_cfg()
        if not cfg or self.engine_running():
            return
        exe = self._engine_exe()
        if not exe:
            raise EngineUnavailable(
                "llama-server not found: set LLAMA_SERVER and MODELS_DIR")
        model = models_mod.active_path()
        if not model:
            raise EngineUnavailable(
                "no local model chosen yet: pick one in the settings")
        args = [_expand(str(a), {"MODEL": model}) for a in self._engine_args(cfg)]
        if any(a is None for a in args):
            raise EngineUnavailable(
                "the engine command line refers to something that is not set")
        (RUNTIME_DIR / "slots").mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "CUDA_DEVICE_ORDER": "PCI_BUS_ID"}
        # Hiding the console window is a Windows-only flag, and passing it anywhere else
        # raises before the process even starts.
        quiet = ({"creationflags": subprocess.CREATE_NO_WINDOW}
                 if platform.system() == "Windows" else {"start_new_session": True})
        out_log = open(RUNTIME_DIR / "srv_out.log", "w")
        err_log = open(RUNTIME_DIR / "srv_err.log", "w")
        try:
            proc = subprocess.Popen(
                [exe, *args],
                cwd=RUNTIME_DIR.parent,
                env=env,
                stdout=out_log,
                stderr=err_log,
                **quiet,
            )
        except OSError as e:
            # This used to surface as an opaque 500: the user picked the profile from
            # the menu and had no idea what had gone wrong.
            out_log.close()
            err_log.close()
            raise EngineUnavailable(f"llama-server will not start: {e}") from e
        # Neither the process nor these two files were ever kept anywhere: llama-server
        # (a couple of GB once a model is loaded) used to outlive Dyla itself, and the log
        # handles leaked right along with it. shutdown() is what closes the loop, called
        # from main.py's own @app.on_event("shutdown").
        self._process = proc
        self._log_files = [out_log, err_log]
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.engine_running():
                return
            time.sleep(2)
        raise RuntimeError("llama-server is not answering, see runtime/srv_err.log")

    def shutdown(self) -> None:
        """Stops the llama-server process we started (if any) and closes its log files.

        A no-op when nothing was ever started here — the user's own build, run outside
        Dyla via LLAMA_SERVER, is theirs to manage, not ours to kill."""
        if self._process is not None:
            if self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._process.kill()
            self._process = None
        for f in self._log_files:
            f.close()
        self._log_files = []
