import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client";
import { decideReload } from "../lib/reloadDecision";
import type { DocKind } from "../types";

/**
 * Loads a live document (estimate/data_model/mockup) and reloads it whenever `tick` changes
 * (bumped at the end of a WS turn, see chatStore filesTick) — so if the agent edits the file
 * while the document is open in the viewer, the UI catches up without reopening the project.
 *
 * If the user has unsaved inline edits (dirty), it does NOT silently overwrite them: it flags
 * `stale=true` so the view can show a warning, and reloads only on an explicit request
 * (reloadDiscardingChanges).
 */
export function useReloadableDoc<T>(project: string, kind: DocKind, tick: number) {
  const [doc, setDoc] = useState<T | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [stale, setStale] = useState(false);

  const dirtyRef = useRef(false);
  // False until the effect below has run once. It exists because the mount is the one case
  // `prevKey` cannot detect: on the first render prevKey is initialised to the CURRENT key,
  // so "did the project change?" is false, and without this the effect would fall through to
  // the tick branch and return without ever fetching. That was a real bug — every document
  // in the viewer sat on "loading…" until you switched project and came back.
  const hasLoaded = useRef(false);
  const lastSeenTick = useRef(tick);
  // Identifies "which project/doc am I currently loaded for": tracked separately from the
  // [project, kind] effect dependency array because that array only tells React whether to
  // RE-RUN the effect, not whether THIS render is the one that changed it (see below).
  const prevKey = useRef(`${project}:${kind}`);
  // Guards against an out-of-order response: fetchDoc is called both from the effect and
  // from reloadDiscardingChanges, so a plain per-effect "alive" flag isn't enough — a slow
  // response for a project (or doc) you've since navigated away from must never land on
  // top of whatever loaded after it, no matter which caller issued which request.
  const requestId = useRef(0);
  // True only while this hook instance is mounted, for the one case requestId cannot cover:
  // there is no "newer" request after unmount to make an in-flight one look stale.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
    // Going back to "not dirty" only happens after a successful save: at that point the local
    // document matches the one on disk, so the staleness warning no longer applies.
    if (!v) setStale(false);
  };

  const fetchDoc = () => {
    const id = ++requestId.current;
    return apiClient
      .getDoc(project, kind)
      .then((d) => {
        if (!mounted.current || id !== requestId.current) return;
        setDoc(d as unknown as T);
        setLoadError(null);
        setDirty(false);
        setStale(false);
      })
      .catch((e) => {
        if (!mounted.current || id !== requestId.current) return;
        setLoadError(e instanceof Error ? e.message : "error");
      });
  };

  // Single effect for BOTH triggers (project/kind change and tick change), instead of two
  // separate effects keyed on different dependency arrays. Two effects was the original bug:
  // a project switch reset the first-tick guard in the [project, kind] effect, but the [tick]
  // effect only re-runs when `tick` itself changes — so a real tick change arriving on the
  // NEW project ran into a guard meant for a mount that had happened on the OLD one, and ate
  // that first genuine update. One effect watching all three deps sees both as the same kind
  // of event; which one it was is decided in lib/reloadDecision.ts.
  useEffect(() => {
    const key = `${project}:${kind}`;
    const projectChanged = key !== prevKey.current;
    prevKey.current = key;

    const action = decideReload({
      hasLoaded: hasLoaded.current,
      keyChanged: projectChanged,
      tick,
      lastSeenTick: lastSeenTick.current,
    });
    if (action === "skip") return;

    hasLoaded.current = true;
    lastSeenTick.current = tick;

    if (action === "reset-and-load") {
      setDoc(null);
      setLoadError(null);
      setDirty(false);
      setStale(false);
    }
    // Only a reload can arrive on top of unsaved edits — a mount has none, and a project
    // change has already discarded them along with the document they belonged to.
    if (action === "reload" && dirtyRef.current) {
      setStale(true); // do not clobber unsaved edits: warn only
      return;
    }
    fetchDoc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, kind, tick]);

  const reloadDiscardingChanges = () => {
    fetchDoc();
  };

  return { doc, setDoc, loadError, dirty, setDirty, stale, reloadDiscardingChanges };
}
