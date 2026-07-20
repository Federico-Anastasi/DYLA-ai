import { Fragment } from "react";
import type { ReactNode } from "react";
import { parseInline, parseMarkdown } from "../../lib/markdown";
import { slugify } from "../../lib/slug";
import QuestionsCard from "./QuestionsCard";

// A clickable citation written by the agent: opens the document at the cited spot.
export type CiteHandler = (doc: string, target: string) => void;

function renderInline(text: string, onCite?: CiteHandler): ReactNode {
  return parseInline(text).map((tok, i) => {
    switch (tok.type) {
      case "code":
        return <code key={i}>{tok.text}</code>;
      case "bold":
        return <strong key={i}>{tok.text}</strong>;
      case "italic":
        return <em key={i}>{tok.text}</em>;
      case "cite":
        // With no handler it stays plain text: a citation you cannot click beats a button that
        // does nothing.
        return onCite ? (
          <button
            key={i}
            type="button"
            className="cite-chip"
            title={`Open ${tok.doc.toUpperCase()}: ${tok.target}`}
            onClick={() => onCite(tok.doc, tok.target)}
          >
            {tok.label}
          </button>
        ) : (
          <Fragment key={i}>{tok.label}</Fragment>
        );
      default:
        return <Fragment key={i}>{tok.text}</Fragment>;
    }
  });
}

function renderMultiline(text: string, onCite?: CiteHandler): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(line, onCite)}
    </Fragment>
  ));
}

export default function Markdown({
  text,
  onSubmitAnswers,
  onCite,
  anchorIds = false,
}: {
  text: string;
  onSubmitAnswers?: (answers: string) => void;
  onCite?: CiteHandler;
  // true = every heading gets the slug of its own text as its id, so a citation can scroll to it.
  // Only needed inside documents, not in chat messages.
  anchorIds?: boolean;
}) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading": {
            const Tag = `h${Math.min(b.level + 2, 6)}` as keyof JSX.IntrinsicElements;
            return (
              <Tag key={i} id={anchorIds ? slugify(b.text) : undefined}>
                {renderInline(b.text, onCite)}
              </Tag>
            );
          }
          case "paragraph":
            return b.text.trim() ? <p key={i}>{renderMultiline(b.text, onCite)}</p> : null;
          case "list":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, onCite)}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "table":
            return (
              <table key={i}>
                <thead>
                  <tr>
                    {b.header.map((h, j) => (
                      <th key={j}>{renderInline(h, onCite)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((c, ci) => (
                        <td key={ci}>{renderInline(c, onCite)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          case "questions":
            if (!b.closed) return <p key={i} className="qa-preparing">…preparing the questions…</p>;
            if (!b.questions) return <pre key={i}><code>{b.raw}</code></pre>;
            return <QuestionsCard key={i} questions={b.questions} onSubmit={onSubmitAnswers} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
