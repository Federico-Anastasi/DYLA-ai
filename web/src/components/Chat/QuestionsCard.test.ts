import { describe, expect, it } from "vitest";
import { formatAnswer } from "./QuestionsCard";

describe("formatAnswer", () => {
  it("merges the option and the free text: the detail must not be lost", () => {
    expect(formatAnswer({ option: "Fixed-width TXT", free: "layout due in September" }))
      .toBe("Fixed-width TXT — layout due in September");
  });

  it("uses the option alone when there is no free text", () => {
    expect(formatAnswer({ option: "Excel / CSV", free: "  " })).toBe("Excel / CSV");
  });

  it("uses the free text alone when no option is selected", () => {
    expect(formatAnswer({ free: "depends on the layout" })).toBe("depends on the layout");
  });

  it("flags unanswered questions explicitly", () => {
    expect(formatAnswer({ free: "" })).toBe("no answer");
    expect(formatAnswer(undefined)).toBe("no answer");
  });
});
