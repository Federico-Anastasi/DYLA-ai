"""Short summary of the brief via Haiku, to fill in the "Activity" line of context.md.

The user creates the project with a name and a client; the activity is what the model
derives from the brief on first upload. Only the first ~3 pages are read: you do not
need to read a whole brief to know what it is about, and this way the cost stays
negligible.

The text arrives already extracted from server/ingest.py: at this point there is no
difference between a text brief and a binary one, a PDF is worth a markdown file.
"""
from claude_agent_sdk import ClaudeAgentOptions, query

HEAD_CHARS = 6000  # ~3 pages

_SYSTEM = "Summarise in a dry, concrete way. Answer in English."

_PROMPT = (
    "This is the beginning of a project brief.\n"
    "Write 2-3 lines saying what the project is about: the application domain and what "
    "the application has to do. No preamble, no bullet points, just the lines.\n\n"
    "---\n{head}\n---"
)


async def summarize_brief(text: str, env: dict | None = None) -> str | None:
    """2-3 lines about the project, or None if it cannot be done (never an exception to
    the caller: uploading the brief must work even with no model reachable)."""
    head = text[:HEAD_CHARS].strip()
    if not head:
        return None
    options = ClaudeAgentOptions(
        model="claude-haiku-4-5",
        allowed_tools=[],
        max_turns=1,
        system_prompt=_SYSTEM,
        env=dict(env or {}),
    )
    chunks: list[str] = []
    try:
        async for msg in query(prompt=_PROMPT.format(head=head), options=options):
            if type(msg).__name__ == "AssistantMessage":
                for block in msg.content:
                    if type(block).__name__ == "TextBlock":
                        chunks.append(block.text)
    except Exception:
        return None
    return " ".join(" ".join(chunks).split()) or None
