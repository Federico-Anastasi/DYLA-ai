import { describe, expect, it } from "vitest";
import { decideReload } from "./reloadDecision";

describe("decideReload", () => {
  // The regression this file exists for. On the first render a view compares the current
  // project against a ref initialised to that same project, so keyChanged is false — and the
  // old code took that to mean "nothing happened" and returned without fetching. Every
  // document sat on "loading…" until the user switched project and came back.
  it("fetches on the first run even though nothing changed", () => {
    expect(decideReload({ hasLoaded: false, keyChanged: false, tick: 0, lastSeenTick: 0 }))
      .toBe("load");
  });

  it("clears the screen and fetches when the project changes", () => {
    expect(decideReload({ hasLoaded: true, keyChanged: true, tick: 4, lastSeenTick: 4 }))
      .toBe("reset-and-load");
  });

  // A project switch on a view that has never loaded is still a reset: whatever the previous
  // project left in state has to go before the new document lands.
  it("treats a project change as a reset even before the first load", () => {
    expect(decideReload({ hasLoaded: false, keyChanged: true, tick: 0, lastSeenTick: 0 }))
      .toBe("reset-and-load");
  });

  it("reloads when a turn has ended", () => {
    expect(decideReload({ hasLoaded: true, keyChanged: false, tick: 5, lastSeenTick: 4 }))
      .toBe("reload");
  });

  // The effect depends on [project, tick] but React re-runs it on any of them changing; a
  // re-render with the same tick must not produce a second request for the same file.
  it("does nothing when the effect re-runs on an unchanged tick", () => {
    expect(decideReload({ hasLoaded: true, keyChanged: false, tick: 4, lastSeenTick: 4 }))
      .toBe("skip");
  });

  // The first tick after mounting is usually the same value the view mounted with. If that
  // were treated as a reload the view would fetch twice on open, which is what the old
  // first-tick guard was trying to prevent — the guard was right, it was just placed where it
  // also swallowed the mount.
  it("does not fetch twice when the first tick equals the one seen at mount", () => {
    const afterMount = { hasLoaded: true, lastSeenTick: 7 };
    expect(decideReload({ ...afterMount, keyChanged: false, tick: 7 })).toBe("skip");
  });
});
