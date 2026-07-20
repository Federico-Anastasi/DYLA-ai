/**
 * When a viewer effect runs, what should it do: fetch, or nothing?
 *
 * Every document view in the viewer answers this same question, and each one used to answer
 * it with its own copy of the same nested ifs. They all had the same bug: the mount was
 * detected by comparing the current key against a ref initialised to that very key, so
 * "changed?" was false on the first render, control fell through to the tick branch, and the
 * effect returned without ever fetching. Nothing loaded until you switched project and came
 * back — and because none of it was reachable from a pure function, 176 tests had nothing to
 * say about it.
 *
 * So the decision lives here, on its own, where it can be tested without a DOM.
 */
export type ReloadAction =
  /** First run for this view: fetch, nothing on screen to clear. */
  | "load"
  /** The project (or file) changed: clear what is on screen, then fetch. */
  | "reset-and-load"
  /** A turn ended and the file may have changed underneath: fetch again, quietly. */
  | "reload"
  /** The effect re-ran but nothing we care about moved. */
  | "skip";

export function decideReload(state: {
  /** Has this view fetched at least once? (a ref, false until the first effect run) */
  hasLoaded: boolean;
  /** Did the project — or the file, for the markdown view — change on this render? */
  keyChanged: boolean;
  /** filesTick: bumped at the end of a chat turn. */
  tick: number;
  /** The tick value at the last fetch. */
  lastSeenTick: number;
}): ReloadAction {
  // Checked before hasLoaded: switching project on a view that has already loaded is still a
  // reset, and on the very first render keyChanged is false by construction.
  if (state.keyChanged) return "reset-and-load";
  if (!state.hasLoaded) return "load";
  if (state.tick === state.lastSeenTick) return "skip";
  return "reload";
}
