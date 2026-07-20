"""Backend configuration loading (server/config.yaml)."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROJECTS_DIR = ROOT / "projects"
RUNTIME_DIR = ROOT / "runtime"

CONFIG: dict = yaml.safe_load((ROOT / "server" / "config.yaml").read_text(encoding="utf-8"))
