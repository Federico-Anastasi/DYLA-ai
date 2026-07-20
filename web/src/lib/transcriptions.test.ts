import { describe, expect, it } from "vitest";
import { titleFromFile } from "./transcriptions";

// The same cases as server/tests/test_meetings.py::test_title_from_filename: the two
// implementations must produce the same title, otherwise the user sees one name in the field
// and gets another one in the file.
describe("titleFromFile", () => {
  it.each([
    ["2026-07-20 Weekly status.m4a", "Weekly status"],
    ["20260720_kickoff_acme.mp3", "kickoff acme"],
    ["recording.wav", "recording"],
  ])("%s -> %s", (filename, expected) => {
    expect(titleFromFile(filename)).toBe(expected);
  });

  it("a name that reduces to nothing does not produce an empty title", () => {
    expect(titleFromFile("2026-07-20.m4a")).toBe("Meeting");
  });
});
