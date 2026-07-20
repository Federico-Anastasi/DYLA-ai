import { Icon } from "../icons";

// Highlighted message (schema type 'banner') in the four standard tones: info/success/warning/
// error. Coloured left border + tinted background + a matching icon.
const STYLE_ICON: Record<string, string> = { info: "info", success: "check-circle", warning: "triangle-alert", error: "alert-circle" };

export function Banner({ style = "info", title, text }: { style?: "info" | "success" | "warning" | "error"; title?: string; text: string }) {
  return (
    <div className={`mk-banner mk-banner-${style}`}>
      <span className="mk-banner-icon">
        <Icon name={STYLE_ICON[style] ?? "info"} size={17} />
      </span>
      <span className="mk-banner-body">
        {title && <strong>{title} </strong>}
        {text}
      </span>
    </div>
  );
}
