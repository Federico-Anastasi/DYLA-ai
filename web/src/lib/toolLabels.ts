// Readable labels for the agent's activity — the technical detail stays in the tooltip.
const TOOL_LABELS: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  Bash: "Running a command",
  PowerShell: "Running a command",
  Glob: "Looking for files",
  Grep: "Searching",
  Skill: "Starting the skill",
  Task: "Subagent at work",
  Agent: "Subagent at work",
  TodoWrite: "Updating the plan",
  WebSearch: "Searching the web",
  WebFetch: "Reading a web page",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name;
}

/** Short text for the activity line (label - truncated detail). */
export function toolText(name: string, input: string | undefined | null): string {
  const label = toolLabel(name);
  let detail = input || "";
  if (/[\\/]/.test(detail) && !detail.includes(" ")) detail = detail.split(/[\\/]/).pop() || detail;
  if (detail.length > 70) detail = detail.slice(0, 67) + "…";
  return detail ? `${label} — ${detail}` : label;
}
