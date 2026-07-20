import type { ReactNode } from "react";
import { Icon } from "../icons";

// Application chrome (topbar + navigation), themed. The three themes are genuinely different
// structures, not just different colours: "standard" and "plain" put a dark full-width topbar on
// top and then, inside the page content under the title, a row of horizontal pill tabs (back link
// -> title -> tabs); "compact" has no topbar at all — a white left sidebar carries the wordmark,
// a vertical menu, and the user plus wordmark in its footer. That is why Topbar and NavMenu branch
// on the theme instead of being pure CSS.
//
// The caller (MockupView) owns the "ask Dyla" mechanism: Topbar and NavMenu here are pure dumb
// renders, and the Inspectable wrapping (one anchor per component) happens outside this file.

export type MockupTheme = "standard" | "compact" | "plain";

function initialsOf(name: string): string {
  return (
    String(name || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "U"
  );
}

export function Topbar({ theme, title, user }: { theme: MockupTheme; title: string; user: string }) {
  const initials = initialsOf(user || "Demo User");

  if (theme === "compact") {
    // No topbar in the compact theme: the same information (user + wordmark) lives in the sidebar
    // footer, which is why AppShell drops this very node at the bottom of the sidebar.
    return (
      <div className="mk-sidebar-footer">
        <span className="mk-avatar">{initials}</span>
        <span className="mk-sidebar-user">{user || "Demo User"}</span>
        <span className="mk-brand-wordmark">{title || "acme"}</span>
      </div>
    );
  }

  return (
    <header className="mk-topbar">
      <div className="mk-topbar-left">
        <Icon name="file-text" size={19} />
        <span className="mk-topbar-title">{title}</span>
      </div>
      <div className="mk-topbar-right">
        <Icon name="grid-dots" size={18} />
        <span className="mk-avatar">{initials}</span>
        <span className="mk-topbar-user">{user || "Demo User"}</span>
        <span className="mk-brand-wordmark">{title || "acme"}</span>
      </div>
    </header>
  );
}

export function NavMenu({
  theme,
  items,
  currentPageId,
  onNavigate,
}: {
  theme: MockupTheme;
  items: { label: string; page: string }[];
  currentPageId: string;
  onNavigate: (page?: string) => void;
}) {
  const cls = theme === "compact" ? "mk-nav mk-nav-sidebar" : "mk-nav mk-nav-tabs";
  return (
    <nav className={cls}>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          className={`mk-nav-item${it.page === currentPageId ? " active" : ""}`}
          onClick={() => onNavigate(it.page)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}

// Static wordmark block for the compact theme: accent square + word + grid launcher icon. It does
// not come from mockup.json — it is fixed chrome that belongs to the theme, a placeholder standing
// in for whatever product identity the mockup is meant to suggest.
function SidebarBrand({ title }: { title?: string }) {
  return (
    <div className="mk-sidebar-brand">
      <span className="mk-brand-mark" aria-hidden="true" />
      <span className="mk-brand-word">{title || "acme"}</span>
      <span className="mk-brand-launcher">
        <Icon name="grid-dots" size={16} />
      </span>
    </div>
  );
}

export function AppShell({
  theme,
  topbar,
  nav,
  modal,
  title,
  children,
}: {
  theme: MockupTheme;
  topbar: ReactNode;
  // standard/plain: NOT used here — the nav belongs in the content flow, under the page title, and
  // the caller composes it inside 'children' (see MockupView). This stays a parameter only for the
  // compact theme, where the nav really does live in the sidebar.
  nav: ReactNode;
  // An open dialog (a page with kind='modal'), rendered INSIDE the .mk-shell-* div so it inherits
  // the theme's CSS custom properties (--mk-primary and friends) and the scoped
  // .mk-shell-{theme} .mk-modal-* rules. Absent/undefined = no dialog open.
  modal?: ReactNode;
  // The product name from mockup.json's topbar.props.title (see Topbar above). Compact theme
  // only: it drives the sidebar wordmark, the same brand that the topbar carries on the other
  // two themes. Falls back to "acme" when the mockup doesn't set one.
  title?: string;
  children: ReactNode;
}) {
  if (theme === "compact") {
    return (
      <div className="mk-shell mk-shell-compact">
        <div className="mk-shell-row">
          <aside className="mk-sidebar">
            <SidebarBrand title={title} />
            {nav}
            {topbar}
          </aside>
          <main className="mk-main">
            <div className="mk-page-inner">{children}</div>
          </main>
        </div>
        {modal}
      </div>
    );
  }

  // standard/plain: the dark topbar stays full-width chrome ABOVE the content; the pill nav is no
  // longer a bar here — the caller renders it inside 'children', right after the page title (inside
  // mk-page-inner), so the page reads back link -> title -> tabs.
  return (
    <div className={`mk-shell mk-shell-${theme}`}>
      {topbar}
      <main className="mk-main">
        <div className="mk-page-inner">{children}</div>
      </main>
      {modal}
    </div>
  );
}
