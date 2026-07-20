import { Icon } from "../icons";

// Full-width centred status band (schema type 'statusbar'), e.g. "Completed" on a filled background
// with a check icon at the top of a form. This is page content, not global chrome.
const TONE_ICON: Record<string, string> = { info: "info", success: "check", warning: "triangle-alert", error: "alert-circle" };

export function StatusBar({ label, tone = "success", icon }: { label: string; tone?: "info" | "success" | "warning" | "error"; icon?: string }) {
  const iconName = icon || TONE_ICON[tone] || "check";
  return (
    <div className={`mk-statusbar mk-statusbar-${tone}`}>
      {iconName && <Icon name={iconName} size={17} />}
      <span>{label}</span>
    </div>
  );
}
