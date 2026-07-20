import { toolText } from "../../lib/toolLabels";

export default function ToolLine({ name, input }: { name: string; input: string }) {
  return (
    <div className="tool-line" title={input ? `${name}: ${input}` : name}>
      {toolText(name, input)}
    </div>
  );
}
