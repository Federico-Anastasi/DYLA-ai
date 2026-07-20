import { useEffect, useRef, useState } from "react";
import { fileUrl } from "../../api/client";
import { decideReload } from "../../lib/reloadDecision";
import Markdown from "../Chat/Markdown";

export default function MarkdownFileView({
  project,
  file,
  tick,
  anchor,
}: {
  project: string;
  file: string;
  tick: number;
  // Slug of the chapter to jump to: comes from a citation clicked in chat.
  anchor?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // One effect for both "file changed" and "tick changed", with the decision itself in
  // lib/reloadDecision.ts (shared with the other views and unit-tested there), plus a request
  // id so a slow response for a file you've since navigated away from cannot overwrite what
  // loaded after it.
  const prevKey = useRef(`${project}:${file}`);
  const lastSeenTick = useRef(tick);
  const requestId = useRef(0);

  const load = () => {
    const id = ++requestId.current;
    return fetch(fileUrl(project, file))
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
      .then((t) => { if (id === requestId.current) setText(t); })
      .catch((e) => { if (id === requestId.current) setError(e.message); });
  };

  // initial load (shows the spinner) on mount / file change, and silent reload at the end
  // of a turn — the file may have been modified (context.md, say).
  useEffect(() => {
    const key = `${project}:${file}`;
    const fileChanged = key !== prevKey.current;
    prevKey.current = key;

    const action = decideReload({
      hasLoaded: hasLoaded.current,
      keyChanged: fileChanged,
      tick,
      lastSeenTick: lastSeenTick.current,
    });
    if (action === "skip") return;

    hasLoaded.current = true;
    lastSeenTick.current = tick;

    if (action === "reset-and-load") {
      setText(null);
      setError(null);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, file, tick]);

  // Scroll to the cited chapter. Depends on the text as well as the anchor: when the
  // citation lands before the file is loaded, the element doesn't exist yet.
  useEffect(() => {
    if (!anchor || text == null) return;
    const el = boxRef.current?.querySelector(`#${CSS.escape(anchor)}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("anchor-hit");
    const t = setTimeout(() => el.classList.remove("anchor-hit"), 2000);
    return () => clearTimeout(t);
  }, [anchor, text]);

  if (error) return <div className="viewer-empty">Load error: {error}</div>;
  if (text == null) return <div className="spinner-block"><span className="spinner" />loading…</div>;
  return (
    <div className="md-view" ref={boxRef}>
      <Markdown text={text} anchorIds />
    </div>
  );
}
