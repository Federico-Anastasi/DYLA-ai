"""Getting llama-server onto this machine, without asking the user to build it.

The local model is Dyla's normal case, so "first compile llama.cpp" cannot be the
first step. The project publishes prebuilt binaries for every platform; we work out
which one belongs here, download it once into `runtime/llama/`, and use it from there.

Anyone who already has their own build just sets LLAMA_SERVER and none of this runs —
their binary is almost certainly better tuned than the generic one.

Sizes, so nobody is surprised: the macOS, Linux and Windows-CPU builds are 10-20 MB;
the Windows CUDA build is around 150 MB because it carries the CUDA runtime with it.
"""
from __future__ import annotations

import json
import platform
import shutil
import tarfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .config import RUNTIME_DIR

LATEST_RELEASE = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
INSTALL_DIR = RUNTIME_DIR / "llama"

# The binary name inside the archive, per platform.
EXE_NAME = "llama-server.exe" if platform.system() == "Windows" else "llama-server"


class EngineDownloadFailed(RuntimeError):
    """The engine could not be fetched: no network, or no build for this platform."""


def asset_pattern(accelerator: str) -> str:
    """The fragment that identifies our build among the release assets.

    llama.cpp names them `llama-b<build>-bin-<platform>-<arch>.<ext>`, so matching on
    the middle part survives the build number changing every day.
    """
    system, machine = platform.system(), platform.machine().lower()
    if system == "Darwin":
        # Intel Macs are still published, but arm64 is the one that matters now.
        return "bin-macos-arm64" if machine == "arm64" else "bin-macos-x64"
    if system == "Windows":
        if accelerator == "cuda":
            # There are builds for several CUDA versions; the caller picks the newest
            # match, and any of them works with a recent driver.
            return "bin-win-cuda"
        return "bin-win-cpu-arm64" if machine == "arm64" else "bin-win-cpu-x64"
    # Linux: the plain CPU build. Vulkan and ROCm exist, but guessing which one suits
    # someone's setup is a worse failure than being predictable.
    return "bin-ubuntu-x64"


def installed_exe() -> Path | None:
    """The engine we downloaded earlier, if it is still there."""
    found = next(INSTALL_DIR.rglob(EXE_NAME), None)
    return found if found and found.is_file() else None


def _pick_asset(assets: list[dict], pattern: str) -> dict:
    matching = [a for a in assets if pattern in a.get("name", "")]
    if not matching:
        raise EngineDownloadFailed(
            f"llama.cpp does not publish a build matching '{pattern}' for this platform. "
            "Build it yourself and point LLAMA_SERVER at it.")
    # Several CUDA versions can match: take the last by name, which is the newest.
    return sorted(matching, key=lambda a: a["name"])[-1]


def _assert_safe_zip_members(z: zipfile.ZipFile, into: Path) -> None:
    """Raises EngineDownloadFailed if any member of `z` would land outside `into` once
    extracted (Zip Slip: a member named e.g. "../../etc/whatever" or an absolute path).

    The archive here comes straight from a GitHub release download, not from the user —
    but "we chose the URL" is not the same as "we control the bytes", and extractall()
    on an untrusted zip is the textbook path-traversal primitive. tarfile got this
    fixed upstream (the `filter="data"` argument below); zipfile has not, so it is
    checked by hand here.
    """
    root = into.resolve()
    for info in z.infolist():
        target = (root / info.filename).resolve()
        if not target.is_relative_to(root):
            raise EngineDownloadFailed(
                f"the downloaded archive contains an unsafe path: '{info.filename}'")


def _unpack(archive: Path, into: Path) -> None:
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as z:
            _assert_safe_zip_members(z, into)
            z.extractall(into)
    else:
        with tarfile.open(archive) as t:
            # filter="data" (PEP 706): refuses absolute paths, ".." traversal, device
            # files and anything else a tar member should not be able to do to the
            # filesystem it is extracted into.
            t.extractall(into, filter="data")


def install(accelerator: str, progress=None) -> Path:
    """Downloads and unpacks the build for this machine. Returns the executable.

    `progress(fraction)` is called as the download proceeds, so a UI can show it: the
    CUDA build is large enough that silence would look like a hang.
    """
    pattern = asset_pattern(accelerator)
    try:
        with urllib.request.urlopen(LATEST_RELEASE, timeout=30) as r:
            release = json.load(r)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        raise EngineDownloadFailed(f"cannot reach the llama.cpp releases: {e}") from e

    asset = _pick_asset(release.get("assets", []), pattern)
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    archive = INSTALL_DIR / asset["name"]
    total = asset.get("size") or 0

    try:
        with urllib.request.urlopen(asset["browser_download_url"], timeout=60) as r, \
             archive.open("wb") as out:
            done = 0
            while chunk := r.read(1 << 16):
                out.write(chunk)
                done += len(chunk)
                if progress and total:
                    progress(min(1.0, done / total))
    except (urllib.error.URLError, OSError) as e:
        archive.unlink(missing_ok=True)
        raise EngineDownloadFailed(f"download failed: {e}") from e

    try:
        _unpack(archive, INSTALL_DIR)
    except (zipfile.BadZipFile, tarfile.TarError) as e:
        raise EngineDownloadFailed(f"the downloaded archive is unreadable: {e}") from e
    finally:
        # The archive is a few hundred megabytes of nothing once unpacked.
        archive.unlink(missing_ok=True)

    exe = installed_exe()
    if not exe:
        raise EngineDownloadFailed(
            f"'{EXE_NAME}' is not in the archive that was downloaded")
    if platform.system() != "Windows":
        exe.chmod(exe.stat().st_mode | 0o111)  # the tarball does not always keep +x
    if progress:
        progress(1.0)
    return exe


def clear() -> None:
    """Throws away the downloaded engine, so the next start fetches it again."""
    shutil.rmtree(INSTALL_DIR, ignore_errors=True)


# --- what this machine has to spare ---

def _vram_gb() -> float:
    """Total VRAM across the NVIDIA cards, or 0 when there are none. Asked of
    nvidia-smi rather than guessed: on a multi-card machine llama.cpp splits across
    all of them, so the number that matters is the sum."""
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return 0.0
    if out.returncode != 0:
        return 0.0
    total = 0.0
    for line in out.stdout.splitlines():
        try:
            # nvidia-smi reports MiB. Converting to decimal GB rather than GiB keeps
            # this comparable with model sizes, which Hugging Face gives in GB — mixing
            # the two units understates the available memory by seven per cent.
            total += float(line.strip()) * 1048576 / 1e9
        except ValueError:
            pass
    return round(total, 1)


def _ram_gb() -> float:
    """Total system RAM. Three ways because there is no portable one in the standard
    library, and this is the number that decides whether a CPU run is even possible."""
    import os
    if platform.system() == "Windows":
        import ctypes

        class _Mem(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        st = _Mem()
        st.dwLength = ctypes.sizeof(_Mem)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return round(st.ullTotalPhys / 1e9, 1)
        return 0.0
    try:  # Linux, and macOS through sysconf as well
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9, 1)
    except (ValueError, OSError, AttributeError):
        return 0.0


def hardware() -> dict:
    """What there is to work with. The user needs this to choose a context size: it is
    the KV cache that decides whether a model loads or dies on startup, and that cost
    is linear in the context."""
    return {"vram_gb": _vram_gb(), "ram_gb": _ram_gb()}
