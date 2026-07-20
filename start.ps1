# start.ps1 - Dyla: FastAPI backend + Claude Agent SDK + web frontend.
# The model (cloud or local) is picked from the web interface, not from here.
#
# This script must fail OUT LOUD. It used to do the opposite: with
# $ErrorActionPreference = "Stop", a single pip warning on stderr was enough to close
# the window without printing anything, and the app just seemed not to start.

Set-Location $PSScriptRoot

$PORT = 3000
$VENV = Join-Path $PSScriptRoot ".venv"

function Fail($message, $howToFix) {
    Write-Host ""
    Write-Host "  $message" -ForegroundColor Red
    if ($howToFix) { Write-Host "  $howToFix" -ForegroundColor Yellow }
    Write-Host ""
    Read-Host "  Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "  Dyla" -ForegroundColor Cyan

# --- Python ---
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Fail "Python not found." ("Install it from python.org (3.10 or newer) and tick " +
        "'Add Python to PATH' during setup.")
}

$version = (python -c "import sys; print('%d.%d' % sys.version_info[:2])")
if ($LASTEXITCODE -ne 0) { Fail "Python does not respond." "Try reinstalling it." }
$maj, $min = $version.Split(".")
if ([int]$maj -lt 3 -or ([int]$maj -eq 3 -and [int]$min -lt 10)) {
    Fail "Python 3.10 or newer is required (found $version)." "Please upgrade Python."
}

# --- Claude Code CLI ---
# claude-agent-sdk does not contain the model: it spawns the `claude` binary. Without
# it the app opens normally and then the chat dies on the first message — the worst
# possible way to find out a prerequisite is missing.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "Claude Code is not installed (and neither is Node.js)." ("Install Node.js " +
            "from nodejs.org, then run:  npm install -g @anthropic-ai/claude-code")
    }
    Fail "Claude Code is not installed." ("Run this once:  " +
        "npm install -g @anthropic-ai/claude-code")
}

# --- is the port free? ---
# Worth saying here: uvicorn on a taken port prints a traceback that helps nobody.
$taken = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if ($taken) {
    Fail "Port $PORT is already in use." ("Dyla is probably already running: " +
        "open http://localhost:$PORT . If it isn't, close whatever is using the port.")
}

# --- virtual environment ---
# Dependencies live in .venv rather than in the system Python: there are a lot of them
# and they are heavy (ctranslate2, onnxruntime, av...), and on a managed machine a
# global install is often not even allowed.
$venvPython = Join-Path $VENV "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "  first run: setting up the environment..." -ForegroundColor DarkGray
    python -m venv $VENV
    if ($LASTEXITCODE -ne 0) {
        Fail "Could not create the virtual environment." "Check that the venv module is available."
    }
}

Write-Host "  checking dependencies..." -ForegroundColor DarkGray
& $venvPython -m pip install -r requirements.txt --quiet --disable-pip-version-check
if ($LASTEXITCODE -ne 0) {
    Fail "Installing dependencies failed." ("The first run needs network access. " +
        "Behind a corporate proxy you may need to configure pip.")
}

# --- go ---
Write-Host "  app: http://localhost:$PORT  (Ctrl+C to stop)" -ForegroundColor DarkGray
Write-Host ""

# The browser opens AFTER the server answers. Opening it first landed on an error page
# and you had to reload by hand.
$opener = Start-Job -ScriptBlock {
    param($port)
    for ($i = 0; $i -lt 60; $i++) {
        try {
            Invoke-WebRequest "http://localhost:$port" -UseBasicParsing -TimeoutSec 2 | Out-Null
            Start-Process "http://localhost:$port"
            return
        } catch { Start-Sleep -Milliseconds 500 }
    }
} -ArgumentList $PORT

try {
    & $venvPython -m uvicorn server.main:app --host 127.0.0.1 --port $PORT
} finally {
    Stop-Job $opener -ErrorAction SilentlyContinue
    Remove-Job $opener -Force -ErrorAction SilentlyContinue
}
