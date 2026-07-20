import { describe, expect, it } from "vitest";
import { OUTPUT_DOCS, diffChangedDocs, docsForProject, labelForDoc, pickAutoOpenDoc, statusFromMeta } from "./documentTabs";

describe("statusFromMeta", () => {
  it("reads a valid status out of meta", () => {
    expect(statusFromMeta({ status: "draft" })).toBe("draft");
    expect(statusFromMeta({ status: "confirmed" })).toBe("confirmed");
  });

  it("ignores a missing or invalid status", () => {
    expect(statusFromMeta({})).toBeUndefined();
    expect(statusFromMeta({ status: "something" })).toBeUndefined();
    expect(statusFromMeta(null)).toBeUndefined();
    expect(statusFromMeta(undefined)).toBeUndefined();
  });
});

describe("diffChangedDocs", () => {
  it("detects a created doc (null -> content)", () => {
    expect(diffChangedDocs({ estimate: null }, { estimate: "{}" })).toEqual(["estimate"]);
  });

  it("detects a modified doc (different content)", () => {
    expect(diffChangedDocs({ estimate: '{"a":1}' }, { estimate: '{"a":2}' })).toEqual(["estimate"]);
  });

  it("ignores unchanged docs", () => {
    const before = { estimate: '{"a":1}', mockup: null };
    const after = { estimate: '{"a":1}', mockup: null };
    expect(diffChangedDocs(before, after)).toEqual([]);
  });

  it("detects several docs changed in the same turn", () => {
    const before = { data_model: "old", estimate: "old", mockup: "old" };
    const after = { data_model: "old", estimate: "new", mockup: "new" };
    expect(diffChangedDocs(before, after).sort()).toEqual(["estimate", "mockup"]);
  });
});

describe("pickAutoOpenDoc", () => {
  it("returns null when nothing changed", () => {
    expect(pickAutoOpenDoc([])).toBeNull();
  });

  it("returns the only doc that changed", () => {
    expect(pickAutoOpenDoc(["mockup"])).toBe("mockup");
  });

  it("follows the pipeline order when several docs change together", () => {
    expect(pickAutoOpenDoc(["mockup", "estimate"])).toBe("estimate");
    expect(pickAutoOpenDoc(["mockup", "data_model"])).toBe("data_model");
  });
});

describe("labelForDoc", () => {
  it("returns the readable label for every doc kind", () => {
    expect(labelForDoc("data_model")).toBe("Data Model");
    expect(labelForDoc("estimate")).toBe("Estimate");
    expect(labelForDoc("mockup")).toBe("Mockup");
  });
});

describe("docsForProject", () => {
  const wf = (extra: Record<string, boolean> = {}) =>
    ({ brief: true, "context.md": true, "estimate.json": true, "data_model.json": false,
       "mockup.json": false, ...extra }) as any;

  it("the brief is a deliverable only for projects that start from discovery", () => {
    expect(docsForProject("discovery", wf(), "output").map((d) => d.doc)).toContain("brief");
    expect(docsForProject("brief", wf(), "output").map((d) => d.doc)).not.toContain("brief");
  });

  it("working files only show up once they really exist", () => {
    expect(docsForProject("brief", wf(), "context")).toEqual([]);
    const withQuestions = docsForProject("brief", wf({ "questions.json": true }), "context");
    expect(withQuestions.map((d) => d.doc)).toEqual(["questions"]);
  });

  it("questions and people have no generate button", () => {
    const questions = OUTPUT_DOCS.find((d) => d.doc === "questions");
    expect(questions?.canGenerate).toBe(false);
  });

  it("a missing source counts as a project with a supplied brief", () => {
    expect(docsForProject(undefined, wf(), "output").map((d) => d.doc)).not.toContain("brief");
  });
});
