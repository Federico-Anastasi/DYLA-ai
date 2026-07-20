import { describe, expect, it } from "vitest";
import { gridActionsPosition, splitRecordViewSide } from "./mockupTheme";

describe("gridActionsPosition", () => {
  it("standard: first column (checkbox + icons ahead of the status column)", () => {
    expect(gridActionsPosition("standard")).toBe("start");
  });

  it("compact: no actions column at all", () => {
    expect(gridActionsPosition("compact")).toBe("none");
  });

  it("plain: last column (the historical default)", () => {
    expect(gridActionsPosition("plain")).toBe("end");
  });
});

describe("splitRecordViewSide", () => {
  const stateProgress = { type: "state-progress" };
  const section = { type: "section" };
  const grid = { type: "grid" };
  const tabs = { type: "tabs" };

  it("standard: never splits, even when the body starts with state-progress", () => {
    expect(splitRecordViewSide("standard", [stateProgress, section, grid])).toEqual({
      side: [],
      main: [stateProgress, section, grid],
    });
  });

  it("compact: no split when the body does not start with state-progress", () => {
    expect(splitRecordViewSide("compact", [grid, tabs])).toEqual({ side: [], main: [grid, tabs] });
  });

  it("compact: isolates state-progress alone when no section follows it", () => {
    expect(splitRecordViewSide("compact", [stateProgress, grid, tabs])).toEqual({
      side: [stateProgress],
      main: [grid, tabs],
    });
  });

  it("compact: isolates state-progress + the section right after it (secondary card)", () => {
    expect(splitRecordViewSide("compact", [stateProgress, section, tabs])).toEqual({
      side: [stateProgress, section],
      main: [tabs],
    });
  });

  it("compact: does not isolate a second, non-consecutive section", () => {
    expect(splitRecordViewSide("compact", [stateProgress, section, grid, section])).toEqual({
      side: [stateProgress, section],
      main: [grid, section],
    });
  });

  it("no split on an empty body", () => {
    expect(splitRecordViewSide("compact", [])).toEqual({ side: [], main: [] });
  });
});
