import { Fragment, useEffect, useRef, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { decideReload } from "../../lib/reloadDecision";
import { slugify } from "../../lib/slug";
import type { BriefDoc } from "../../types";
import { Icon } from "../icons";
import Markdown from "../Chat/Markdown";

// A brief we wrote ourselves (projects whose source is "discovery", see CLAUDE.md) —
// read-only: it's a deliverable, you discuss and correct it in chat, not here. The
// loading/anchor pattern is identical to MarkdownFileView (same file, same `anchor-hit`),
// except the source is brief.json (via apiClient.getDoc) instead of the raw text of a
// .md file.
export default function BriefView({
  project,
  tick,
  anchor,
}: {
  project: string;
  tick: number;
  // Slug of the chapter cited by a chat answer — see lib/slug.ts (it has to stay in step
  // with the server-side computation of the same anchors).
  anchor?: string;
}) {
  const [doc, setDoc] = useState<BriefDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const hasLoaded = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // One effect for both "project changed" and "tick changed", with the decision itself in
  // lib/reloadDecision.ts (shared with the other views and unit-tested there), plus a request
  // id so a slow response for a project you've since left cannot overwrite what loaded after
  // it.
  const prevProject = useRef(project);
  const lastSeenTick = useRef(tick);
  const requestId = useRef(0);

  const load = () => {
    const id = ++requestId.current;
    return apiClient
      .getDoc(project, "brief")
      .then((d) => {
        if (id !== requestId.current) return;
        setDoc(d);
        setError(null);
        setNotFound(false);
      })
      .catch((e) => {
        if (id !== requestId.current) return;
        if (e instanceof ApiError && e.status === 404) {
          setDoc(null);
          setNotFound(true);
          setError(null);
        } else {
          setError(e instanceof Error ? e.message : "error");
        }
      });
  };

  // initial load on mount / project change, and reload at the end of a turn (filesTick) —
  // the agent may have updated the brief.
  useEffect(() => {
    const projectChanged = project !== prevProject.current;
    prevProject.current = project;

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
      setError(null);
      setNotFound(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tick]);

  // Scroll to the cited chapter — same mechanism as MarkdownFileView: it depends on `doc`
  // too, because if the citation arrives before the load completes the heading isn't in
  // the DOM yet.
  useEffect(() => {
    if (!anchor || !doc) return;
    const el = boxRef.current?.querySelector(`#${CSS.escape(anchor)}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("anchor-hit");
    const t = setTimeout(() => el.classList.remove("anchor-hit"), 2000);
    return () => clearTimeout(t);
  }, [anchor, doc]);

  if (error) return <div className="viewer-empty">Brief load error: {error}</div>;
  if (notFound)
    return (
      <div className="viewer-empty">
        <p>No brief has been generated for this project.</p>
        <p className="muted">
          This project starts from meeting transcripts: the brief is one of our own
          deliverables, and it takes shape by working in chat (not through a dedicated skill).
        </p>
      </div>
    );
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  return (
    <div className="brief-doc" ref={boxRef}>
      <div className="brief-head">
        <h1 className="brief-head-title">{doc.meta.title}</h1>
        <div className="brief-head-meta">
          {doc.meta.version != null && <span>v{doc.meta.version}</span>}
          <span>{doc.meta.date}</span>
          {doc.meta.status && <span className={`doc-status-badge ${doc.meta.status}`}>{doc.meta.status}</span>}
        </div>
        {doc.meta.notes && <p className="muted brief-head-note">{doc.meta.notes}</p>}
      </div>

      {doc.chapters.map((ch) => {
        // Chapter level -> heading tag (h1 is reserved for the document title above).
        const Tag = `h${Math.min((ch.level ?? 1) + 1, 6)}` as keyof JSX.IntrinsicElements;
        return (
          <section key={ch.id} className="brief-chapter">
            <Tag id={slugify(ch.title)} className="brief-chapter-title">
              {ch.title}
              {ch.open && (
                <span className="brief-open-badge" title="Chapter still open: content to be completed">
                  <Icon name="triangle-alert" size={12} />
                  open
                </span>
              )}
            </Tag>
            <Markdown text={ch.body} anchorIds />
            {ch.sources && ch.sources.length > 0 && (
              <p className="brief-sources muted">Sources: {ch.sources.join(", ")}</p>
            )}
          </section>
        );
      })}

      {doc.requirements && doc.requirements.length > 0 && (
        <section className="brief-chapter">
          <h2>Requirements</h2>
          <table className="doc-table brief-req-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Description</th>
                <th>Priority</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {doc.requirements.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.title}</td>
                  <td>{r.description}</td>
                  <td>
                    {r.priority && (
                      <span className={`brief-priority brief-priority-${r.priority}`}>{r.priority}</span>
                    )}
                  </td>
                  <td>
                    {r.status && (
                      <span className={`brief-req-status brief-req-status-${r.status}`}>{r.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {doc.glossary && doc.glossary.length > 0 && (
        <section className="brief-chapter">
          <h2>Glossary</h2>
          <dl className="brief-glossary">
            {doc.glossary.map((g, i) => (
              <Fragment key={i}>
                <dt>{g.term}</dt>
                <dd>{g.definition}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}

      {doc.changelog && doc.changelog.length > 0 && (
        <section className="brief-chapter">
          <h2>Changelog</h2>
          <ul className="brief-changelog">
            {doc.changelog.map((c, i) => (
              <li key={i}>
                <span className="brief-changelog-date">{c.date}</span>
                {" — "}
                <span className="muted">{c.source}</span>: {c.summary}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
