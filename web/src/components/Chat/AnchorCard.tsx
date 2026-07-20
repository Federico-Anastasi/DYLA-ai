import type { Anchor } from "../../types";
import { Icon } from "../icons";

export default function AnchorCard({ anchor }: { anchor: Anchor }) {
  return (
    <div className="anchor-card">
      <Icon name="paperclip" size={13} />
      <span className="anchor-file">{anchor.file}{anchor.ref ? ` · ${anchor.ref}` : ""}</span>
      <span className="anchor-label">{anchor.label}</span>
    </div>
  );
}
