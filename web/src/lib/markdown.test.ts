import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, parseQuestionsBlock } from "./markdown";

describe("parseQuestionsBlock", () => {
  it("returns null while the block is still open", () => {
    expect(parseQuestionsBlock('[{"id":1,"q":"hello"', false)).toBeNull();
  });

  it("parses the JSON once the block is closed", () => {
    const qs = parseQuestionsBlock('[{"id":1,"q":"How many areas?","hint":"e.g. 3"}]', true);
    expect(qs).toEqual([{ id: 1, q: "How many areas?", hint: "e.g. 3" }]);
  });

  it("returns null on invalid JSON even when closed", () => {
    expect(parseQuestionsBlock("not json at all", true)).toBeNull();
  });

  it("returns null when the payload is not an array", () => {
    expect(parseQuestionsBlock('{"a":1}', true)).toBeNull();
  });
});

describe("parseMarkdown", () => {
  it("recognises plain paragraphs", () => {
    const blocks = parseMarkdown("Hello world");
    expect(blocks).toEqual([{ type: "paragraph", text: "Hello world" }]);
  });

  it("recognises headings", () => {
    const blocks = parseMarkdown("## Title");
    expect(blocks).toEqual([{ type: "heading", level: 2, text: "Title" }]);
  });

  it("recognises bullet lists", () => {
    const blocks = parseMarkdown("- one\n- two\n- three");
    expect(blocks).toEqual([{ type: "list", items: ["one", "two", "three"] }]);
  });

  it("recognises code fences", () => {
    const blocks = parseMarkdown("```js\nconst x = 1;\n```");
    expect(blocks).toEqual([{ type: "code", lang: "js", text: "const x = 1;" }]);
  });

  it("recognises GFM tables with a header and rows", () => {
    const src = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const blocks = parseMarkdown(src);
    expect(blocks).toEqual([
      {
        type: "table",
        header: ["A", "B"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      },
    ]);
  });

  it("recognises the questions block and marks it open/closed", () => {
    const open = parseMarkdown('```questions\n[{"id":1,"q":"a?"}]');
    expect(open[0]).toMatchObject({ type: "questions", closed: false, questions: null });

    const closed = parseMarkdown('```questions\n[{"id":1,"q":"a?"}]\n```');
    expect(closed[0]).toMatchObject({
      type: "questions",
      closed: true,
      questions: [{ id: 1, q: "a?" }],
    });
  });
});

describe("parseInline", () => {
  it("tokenises bold, italic and code without overlaps", () => {
    const tokens = parseInline("plain **bold** and *italic* and `code`");
    expect(tokens).toEqual([
      { type: "text", text: "plain " },
      { type: "bold", text: "bold" },
      { type: "text", text: " and " },
      { type: "italic", text: "italic" },
      { type: "text", text: " and " },
      { type: "code", text: "code" },
    ]);
  });

  it("returns a single text token when there are no markers", () => {
    expect(parseInline("just text")).toEqual([{ type: "text", text: "just text" }]);
  });
});

describe("parseInline — citations", () => {
  it("recognises a brief citation", () => {
    expect(parseInline("as stated in [[brief:File import]] the file arrives")).toEqual([
      { type: "text", text: "as stated in " },
      { type: "cite", doc: "brief", target: "File import", label: "File import" },
      { type: "text", text: " the file arrives" },
    ]);
  });

  it("uses the explicit label when one is given", () => {
    expect(parseInline("[[brief:ch-3|chapter 3]]")).toEqual([
      { type: "cite", doc: "brief", target: "ch-3", label: "chapter 3" },
    ]);
  });

  it("coexists with bold and code on the same line", () => {
    const tokens = parseInline("**Note**: see [[brief:Constraints]] and `estimate.json`");
    expect(tokens.map((t) => t.type)).toEqual(["bold", "text", "cite", "text", "code"]);
  });

  // The pattern has to be narrow: prose containing square brackets is not a citation.
  it("does not capture ordinary square brackets", () => {
    expect(parseInline("a [reference] and [[not a citation]]")).toEqual([
      { type: "text", text: "a [reference] and [[not a citation]]" },
    ]);
  });
});
