# Dyla

**Develop Your Local Assistant.**

A local workspace where an AI agent helps you carry a project from the first meeting
to the final handover — and every deliverable it produces stays a file on your disk.

**Dyla is built around a model running on your own machine.** Using a frontier model
through an API is the easy road, and it is here as an option; the interesting question
is what a small local model can do when it is put inside a real workflow instead of a
chat window. That is what this project is trying to answer.

Dyla is not a chatbot with a save button. The documents are the point: a brief, an
estimate, a data model, mockups, a schedule, a test plan, a deck. The agent writes them
as validated JSON, you review and correct them in the viewer, and Dyla turns them into
the Excel, Word and PowerPoint files you actually have to send to someone.

Everything runs on your machine. Your projects never leave it.

## Requirements

Two things, once:

```powershell
# 1. Python 3.10 or newer, from python.org — tick "Add Python to PATH"

# 2. Claude Code: this is the engine. The Python package alone is not enough.
npm install -g @anthropic-ai/claude-code     # needs Node.js, from nodejs.org
claude                                        # run once to sign in
```

Then double-click `start.bat` (or run `.\start.ps1`) on Windows, or `./start.sh` on
macOS and Linux. It checks the prerequisites and
tells you plainly what is missing. On first run it creates a `.venv` and installs the
dependencies — a few minutes, and it needs network access. It also downloads a small
speech-to-text model (~460 MB); the larger one for meeting recordings (~3 GB) is only
fetched the first time you transcribe a meeting.

Dyla then opens at http://localhost:3000.

### Choosing the model

Two profiles, picked from the menu at the bottom left:

| Profile | What it is |
|---|---|
| **local** | A model running on this machine, served by `llama-server`, which speaks the Anthropic API natively — so the agent talks to it exactly as it talks to the cloud. This is the default. |
| **sonnet** | Claude Sonnet through your Claude Code login. The comparison, and the fallback when the work needs it. |

**The engine installs itself.** Dyla downloads the prebuilt `llama-server` that
llama.cpp publishes for your platform — Apple Silicon, Windows, Linux, with or without
a GPU — into `runtime/llama/`. It is 10-20 MB for the CPU and Metal builds, around
150 MB for the CUDA one, which carries the CUDA runtime with it. Compiling llama.cpp
should not be the first thing you do to try a tool.

If you already have your own build, point at it and Dyla will use that instead —
yours is almost certainly better tuned for your hardware:

```powershell
setx LLAMA_SERVER "...\llama-cpp\llama-server.exe"
```

**16 GB of memory is the floor**, and 24 GB or more is where this stops being a
compromise. Dyla drives the model through Claude Code, whose system prompt is around
27k tokens before you type anything, so the context wants to be 64k or larger — and
the context is held in memory the whole time it runs. The settings panel works out
what to try first from the model you picked and the memory it finds, and tells you
what to fall back to if the engine will not start.

**The model is your choice**, and it is the part that takes real disk space. Open
*Local model settings* in the sidebar: download one of the suggestions, use a `.gguf`
already in your models folder, or add one from anywhere on disk. The same panel sets
the context and shows what the machine has to work with.

Dyla starts `llama-server` itself when you pick the profile, with flags matched to what
it found: all layers on the GPU with a full context, or everything in RAM with a shorter
one and a thread count based on your cores.

Until there is a model to run, the local profile is hidden rather than offered, and
Dyla starts on `sonnet` — so a fresh clone works out of the box, while the preference
for local stays in the config and takes effect the moment the model is in place.

**On the local profile there are no subagents.** Every turn runs in the main
conversation: a small model does worse when work is split across helpers that each
start from a cold context, and the coordination cost lands on the model least able to
pay it. The cloud profile keeps them.

> **Tested on Windows.** The engine flags, the process launch and the downloaded build
> are all chosen per platform, and macOS and Linux are handled in the code and covered by
> tests. There is a `start.sh` for them, and its checks have been exercised — but nobody
> has yet run Dyla end to end on either, so if you are first, that is the caveat.

## How it works

**A project is a folder.** Everything about it lives in `projects/<name>/`: the input
documents you were given, the deliverables the agent writes, the chat history, and
automatic version snapshots you can roll back from.

**Deliverables are JSON, exports are generated.** Each document has a schema in
`schemas/`, so the agent cannot produce something malformed. The `.xlsx`, `.docx`,
`.pptx`, `.drawio` and `.html` files are rendered by the backend from that JSON,
on demand — which means correcting a number in the viewer is enough, and every export
follows.

**The chat discusses, the viewer shows.** The agent doesn't paste tables into the
conversation. It writes the document as a draft, you look at it in the viewer, and you
argue about it by referring to rows by id. When you're happy, you mark it confirmed.

**Input documents are read, not just stored.** Drop in PDFs, Word, Excel or PowerPoint
files: text is extracted on upload, so the agent can read and quote them. When it claims
"the brief says X", it writes a citation you can click to jump straight to that chapter.

**Meeting recordings become transcripts.** Upload the audio and faster-whisper
transcribes it locally on the CPU — nothing is uploaded anywhere. The transcript lands
where the meeting skill looks for it, with timestamps, and the original audio is kept
until you confirm the transcript is accurate.

**Your own to-do list** lives outside projects, on the home screen, grouped by when
things are due. You can dictate into it: speech is transcribed locally, a model turns it
into dated items, and nothing is written to your agenda until you have reviewed it.

**The agent can search the web**, and the search is ours: three public engines scraped in
parallel, merged and deduplicated, with pages extracted to clean markdown. No API key, no
account, no third-party service. The built-in search tool talks to Anthropic's servers,
which a local model cannot reach — it comes back empty and the turn is wasted — so it is
switched off and replaced by this one. If an engine changes its markup its parser breaks,
and the other two carry the search until it is fixed.

**You can see what the engine is doing.** Under the model selector there is a line that
opens into the numbers: tokens per second while generating, tokens per second while
reading the prompt (they differ by an order of magnitude, and which one you are waiting
on tells you what to do about it), how full the context is, and which conversation the
engine is currently holding in memory — continuing that one is fast, because its prompt
is already cached.

**It can look at pictures, if your model can.** Several of the models worth running
locally are multimodal, but their vision half lives in a separate projector file next to
the weights. If one is there, Dyla loads it and a screenshot of the system being replaced
— or a photo of the whiteboard after a meeting — is something you can hand the agent. The
encoder is kept in RAM rather than on the GPU: on a machine where the model and its
context already fill the cards, another gigabyte there is how the engine fails to start.

**The model carries only the tools it can use.** A tool that is disabled does not merely
refuse to run: its definition never enters the prompt. Measured here, a turn was arriving
with 25 tool definitions weighing 66.5 KB against a 10.7 KB system prompt — six times more
description than instruction, re-sent on every message. Dropping what a local
document-writing app cannot use (agent orchestration, scheduling, git worktrees,
notebooks) took that to 21.5 KB, and a cold turn from 55 seconds to 24.

## Making it yours

Every colour in the interface comes from `web/src/styles/theme.css` — one small file of
CSS variables. Change them, run `npm run build`, and the whole app follows: buttons,
focus rings, charts, the ER diagram. Nothing anywhere else names a colour directly.

The mockup component library has its own three themes (`standard`, `compact`, `plain`)
under `web/src/mockup-lib/themes/`. Those are for the prototypes Dyla produces *for
your client*, and they're separate on purpose: your workspace shouldn't have to look
like the thing you're designing.

**The language** is in Settings, and empty by default — left alone, the agent answers in
whatever language you write to it in, which is what most people want. Fill it in to pin
one: useful when the client's documents are in one language and you work in another, and
the deliverables have to come out in theirs.

## Skills

Skills are what the agent knows how to do. Each one is a folder in `.claude/skills/`
with a single markdown file — plain instructions, no code, meant to be edited.

| Skill | What it produces |
|---|---|
| `/meeting-notes` | A meeting write-up: decisions, open points, actions with an owner |
| `/meeting` | Folds a transcript into the brief, and collects open questions and people |
| `/data-model` | Entities, fields and relationships, with an editable ER diagram |
| `/estimate` | A plan in days: epics, tasks, end-to-end tests, contingency |
| `/dev-tasks` | Breaks each task into assignable pieces of work |
| `/mockup` | Composed page mockups from a themed component library |
| `/test-plan` | Test cases traced back to the epics they cover |
| `/deck` | Kick-off, status and demo decks, as PowerPoint and HTML |
| `/ticket` | Triage for a maintenance ticket on a delivered project |
| `/pipeline` | Runs the sequence end to end |

**Write your own.** A skill is a prompt with a protocol: read these files, ask these
questions, write that document, wait for confirmation. If your work has a deliverable
you produce over and over, it can be a skill — the ones shipped here happen to lean
towards software delivery because that is where Dyla came from, not because the tool
assumes it.

**Let Claude Code do it with you.** This is the real idea behind Dyla: what ships is a
direction and a structure, and it is meant to be bent to your own workflow. You do not
have to do that alone. Open [Claude Code](https://claude.com/claude-code) in a checkout of
this repo and ask it to help — the `CLAUDE.md` at the root has a section written for
exactly that, and it will walk you through adding a skill, giving its document a schema,
wiring up the export, and reworking the estimation rules into yours. That is why the whole
`.claude/` folder is part of the repository and not hidden away: the assistant that guides
the change ships with the thing it changes.

## Development

```powershell
pip install -r requirements-dev.txt
python -m pytest server/tests          # backend
cd web; npm install; npm run test      # frontend
npm run build                          # rebuilds web/dist
```

`web/dist` is committed on purpose, so people can run Dyla without installing Node.
It must be rebuilt and committed **together with** the sources: `index.html` references
the asset files by name, and committing only some of them leaves a broken frontend for
whoever clones next.

The backend is FastAPI plus the Claude Agent SDK; the frontend is React with Vite. The
scheduling engine exists twice on purpose — `web/src/lib/lanes.ts` so the board can
recompute without a round trip, `server/lanes.py` because the Excel export is a GET with
no body — and a parity test keeps the two honest.

## Licence

MIT. See [LICENSE](LICENSE).
