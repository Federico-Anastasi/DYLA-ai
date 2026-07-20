// Cleans an audio file name up into a meeting title.
//
// It duplicates `meetings._title_from_filename` on the backend, which stays the authority: if
// the field comes in empty, the backend decides. Here it only prefills the field, so the user
// sees straight away what the transcription will be called instead of finding out half an
// hour later. Both sides share the same test cases (`server/tests/test_meetings.py`).
export function titleFromFile(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return (
    stem
      // Leading date: "2026-07-20 Status.m4a", "20260720_kickoff.mp3". It would end up
      // duplicated, since the file name already carries it up front.
      .replace(/^\d{4}[-_]?\d{2}[-_]?\d{2}[\s_-]*/, "")
      .replace(/[_-]+/g, " ")
      .trim() || "Meeting"
  );
}
