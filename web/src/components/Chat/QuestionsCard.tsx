import { useState } from "react";
import type { Question } from "../../lib/markdown";

/** An answer to a question: the option that was clicked and/or free text.
 *  The two add up — you can pick "Excel/CSV" and still add "but with no header row". */
type Answer = { option?: string; free: string };

/** Merges the choice and the free text into the line that ends up in Dyla's prompt. */
export function formatAnswer(a: Answer | undefined): string {
  const option = a?.option?.trim();
  const free = a?.free.trim();
  if (option && free) return `${option} — ${free}`;
  return option || free || "no answer";
}

export default function QuestionsCard({ questions, onSubmit }: { questions: Question[]; onSubmit?: (answers: string) => void }) {
  const [sent, setSent] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});

  const keyOf = (q: Question, i: number) => String(q.id ?? i);
  const update = (key: string, patch: Partial<Answer>) =>
    setAnswers((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { free: "" }), ...patch } }));

  const send = () => {
    if (sent || !onSubmit) return;
    const lines = questions.map((q, i) => {
      const prefix = q.id != null ? `${q.id})` : "-";
      return `${prefix} ${formatAnswer(answers[keyOf(q, i)])}`;
    });
    setSent(true);
    onSubmit(`Answers:\n${lines.join("\n")}`);
  };

  return (
    <div className="qa-card">
      {questions.map((q, i) => {
        const key = keyOf(q, i);
        const answer = answers[key];
        const options = q.options?.filter((o) => typeof o === "string" && o.trim()) ?? [];
        return (
          <div className="qa-item" key={key}>
            <label>{q.id != null ? `${q.id}.` : ""} {q.q}</label>
            {options.length > 0 && (
              <div className="qa-options">
                {options.map((opt) => {
                  const active = answer?.option === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      className={`qa-option${active ? " active" : ""}`}
                      disabled={sent}
                      // clicking again deselects: you can answer with free text alone
                      onClick={() => update(key, { option: active ? undefined : opt })}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              className="qa-input"
              rows={1}
              placeholder={q.hint ?? (options.length ? "add a detail (optional)" : "")}
              disabled={sent}
              value={answer?.free ?? ""}
              onChange={(e) => update(key, { free: e.target.value })}
            />
          </div>
        );
      })}
      <button className="qa-send" disabled={sent} onClick={send}>Send answers</button>
    </div>
  );
}
