#!/usr/bin/env bash
# start.sh — Dyla on macOS and Linux: FastAPI backend + Claude Agent SDK + web frontend.
# The model (cloud or local) is chosen from the web interface, not from here.
#
# Like its Windows counterpart, this script must fail OUT LOUD. Every prerequisite is
# checked with the fix printed next to it, because the alternative — the app opening
# normally and the chat dying on the first message — is the worst way to find out
# something is missing.

set -u  # not -e: the checks below report their own failures with a usable message

cd "$(dirname "$0")"

PORT=3000
VENV=".venv"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }

fail() {
    echo
    red "  $1"
    [ $# -gt 1 ] && warn "  $2"
    echo
    exit 1
}

echo
printf '\033[36m  Dyla\033[0m\n'

# --- Python ---
# python3 on macOS and most Linux distributions; `python` alone is often Python 2 or
# absent entirely.
PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done
[ -n "$PYTHON" ] || fail "Python not found." \
    "Install Python 3.10 or newer: brew install python (macOS), or your distribution's package manager."

version=$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) \
    || fail "Python does not respond." "Try reinstalling it."
major=${version%%.*}
minor=${version##*.}
if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 10 ]; }; then
    fail "Python 3.10 or newer is required (found $version)." "Please upgrade Python."
fi

# --- Claude Code CLI ---
# claude-agent-sdk does not contain the model: it spawns the `claude` binary.
if ! command -v claude >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then
        fail "Claude Code is not installed (and neither is Node.js)." \
             "Install Node.js from nodejs.org, then run:  npm install -g @anthropic-ai/claude-code"
    fi
    fail "Claude Code is not installed." \
         "Run this once:  npm install -g @anthropic-ai/claude-code"
fi

# --- is the port free? ---
# uvicorn on a taken port prints a traceback that helps nobody. lsof is on macOS by
# default and on most Linux installs; if it is missing we simply skip the check rather
# than refuse to start over a diagnostic.
if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        fail "Port $PORT is already in use." \
             "Dyla is probably already running: open http://localhost:$PORT . If it isn't, close whatever is using the port."
    fi
fi

# --- virtual environment ---
# Dependencies live in .venv rather than in the system Python: there are a lot of them
# and they are heavy (ctranslate2, onnxruntime, av...), and on macOS the system Python
# refuses a global install outright (PEP 668).
VENV_PYTHON="$VENV/bin/python"
if [ ! -x "$VENV_PYTHON" ]; then
    dim "  first run: setting up the environment..."
    "$PYTHON" -m venv "$VENV" || fail "Could not create the virtual environment." \
        "On Debian and Ubuntu this needs the python3-venv package."
fi

dim "  checking dependencies..."
"$VENV_PYTHON" -m pip install -r requirements.txt --quiet --disable-pip-version-check \
    || fail "Installing dependencies failed." \
            "The first run needs network access. Behind a corporate proxy you may need to configure pip."

# --- go ---
dim "  app: http://localhost:$PORT  (Ctrl+C to stop)"
echo

# The browser opens AFTER the server answers. Opening it first lands on an error page
# and you have to reload by hand.
open_when_ready() {
    for _ in $(seq 1 60); do
        if curl -fsS -o /dev/null --max-time 2 "http://localhost:$PORT" 2>/dev/null; then
            if command -v open >/dev/null 2>&1; then
                open "http://localhost:$PORT"          # macOS
            elif command -v xdg-open >/dev/null 2>&1; then
                xdg-open "http://localhost:$PORT" >/dev/null 2>&1   # Linux desktops
            fi
            return
        fi
        sleep 0.5
    done
}
open_when_ready &
opener=$!
# Whatever happens to the server — Ctrl+C included — the opener does not outlive it.
trap 'kill "$opener" 2>/dev/null' EXIT INT TERM

"$VENV_PYTHON" -m uvicorn server.main:app --host 127.0.0.1 --port "$PORT"
