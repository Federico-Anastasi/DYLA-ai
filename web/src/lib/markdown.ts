// A minimal, pure markdown parser (no DOM dependency) — testable with vitest.
// It covers: paragraphs, headings (#-####), bullet lists, code fences (```lang), GFM tables,
// the special ```questions block (the skills' Q&A) and inline bold/italic/code.

export type Question = { id?: string | number; q: string; hint?: string; options?: string[] };

export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "questions"; questions: Question[] | null; closed: boolean; raw: string };

/** Reads the fenced ```questions block as JSON [{id,q,hint}]. */
export function parseQuestionsBlock(raw: string, closed: boolean): Question[] | null {
  if (!closed) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as Question[];
  } catch {
    return null;
  }
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function isTableDivider(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.replace(/\s/g, ""));
}

function splitCells(row: string): string[] {
  const trimmed = row.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      const closed = i < lines.length;
      if (closed) i++; // consume the closing fence
      const raw = buf.join("\n");
      if (lang === "questions") {
        blocks.push({ type: "questions", questions: parseQuestionsBlock(raw, closed), closed, raw });
      } else {
        blocks.push({ type: "code", lang, text: raw });
      }
      continue;
    }

    if (isTableRow(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(lines[i++]);
      const dataRows = rows.filter((r) => !isTableDivider(r));
      const header = dataRows.length ? splitCells(dataRows[0]) : [];
      const body = dataRows.slice(1).map(splitCells);
      blocks.push({ type: "table", header, rows: body });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph: gather consecutive lines that are neither empty nor special
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !isTableRow(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i].trim())
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", text: buf.join("\n") });
  }

  return blocks;
}

// ---------- inline ----------

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  // A citation of a precise spot in a project document, written by the agent as
  // [[brief:Chapter]] or [[brief:slug|text to show]]. It renders as a clickable chip that
  // opens the document at the cited spot (see Chat/Markdown.tsx).
  | { type: "cite"; doc: string; target: string; label: string };

// Citation format: [[<doc>:<target>]] or [[<doc>:<target>|<label>]].
// Deliberately narrow (no spaces around the colon, no ']' inside the target) because it must
// never capture ordinary prose by accident.
const CITE_RE = /\[\[([a-z_]+):([^\]|]+)(?:\|([^\]]+))?\]\]/;

/** Tokenises bold/italic/code and inline citations, in order of appearance, without
 * overlaps. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const re = new RegExp(`\`([^\`]+)\`|\\*\\*([^*]+)\\*\\*|\\*([^*]+)\\*|${CITE_RE.source}`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: "bold", text: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: "italic", text: m[3] });
    else if (m[4] !== undefined) {
      const target = m[5].trim();
      tokens.push({ type: "cite", doc: m[4], target, label: (m[6] ?? target).trim() });
    }
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens;
}
