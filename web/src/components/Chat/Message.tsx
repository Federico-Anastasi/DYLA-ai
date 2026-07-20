import type { Turn } from "../../types";
import AnchorCard from "./AnchorCard";
import Markdown from "./Markdown";
import type { CiteHandler } from "./Markdown";
import ToolLine from "./ToolLine";

export default function Message({
  turn,
  onSubmitAnswers,
  onCite,
}: {
  turn: Turn;
  onSubmitAnswers?: (answers: string) => void;
  onCite?: CiteHandler;
}) {
  if (turn.role === "user") {
    return (
      <div className="msg user">
        {turn.anchor && <AnchorCard anchor={turn.anchor} />}
        <div className="bubble">{turn.text}</div>
      </div>
    );
  }

  return (
    <div className="msg assistant">
      {turn.segments.map((seg, i) =>
        seg.type === "tool" ? (
          <ToolLine key={i} name={seg.name} input={seg.input} />
        ) : (
          <Markdown key={i} text={seg.text} onSubmitAnswers={onSubmitAnswers} onCite={onCite} />
        ),
      )}
      {turn.is_error && <div className="error-line">Error: {turn.errorMessage}</div>}
      {turn.cost_usd != null && (
        <div className="cost-line">
          ${turn.cost_usd.toFixed(3)} · {turn.duration_s}s
        </div>
      )}
    </div>
  );
}
