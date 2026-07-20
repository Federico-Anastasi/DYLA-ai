import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { useChatStore } from "../../store/chatStore";
import { anchorLabelFor, anchorRefFor } from "../../lib/mockupLabels";
import { gridActionsPosition, splitRecordViewSide } from "../../lib/mockupTheme";
import { decideReload } from "../../lib/reloadDecision";
import type { MockupComponent, MockupDoc, MockupPage } from "../../types";
import { Icon } from "../icons";
import {
  ActionsBar,
  AppShell,
  Banner,
  Breadcrumb,
  DataGrid,
  DetailView,
  Filters,
  FormSection,
  KpiRow,
  Legend,
  NavMenu,
  PageTitle,
  Section,
  SegmentedToggle,
  SidebarNav,
  StateProgress,
  StatusBar,
  TabsShell,
  Tiles,
  Topbar,
  WizardSteps,
  type MockupTheme,
} from "../../mockup-lib";
import "../../mockup-lib/themes/standard.css";
import "../../mockup-lib/themes/compact.css";
import "../../mockup-lib/themes/plain.css";

// Navigable preview of mockup.json inside the viewer panel. It composes the pages with the
// SAME component library (web/src/mockup-lib, mk-* classes) that server/mockup_export.py
// uses for the HTML export: in React here so we can hook hover plus the "ask Dyla" popover
// onto every component (the Inspectable mechanism, unchanged). The mockup fills 100% of the
// panel, with no fake browser chrome around it: it's a real app "inside" the app, on the
// page background of the chosen theme.

function themeOf(raw: string): MockupTheme {
  return raw === "standard" || raw === "compact" ? raw : "plain";
}

// ── inspector: hover -> outline + type chip; click on the chip -> "ask Dyla" popover ──
function Inspectable({
  project,
  anchorRef,
  label,
  type,
  children,
}: {
  project: string;
  anchorRef: string;
  label: string;
  type: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const sendPrompt = useChatStore((s) => s.sendPrompt);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    sendPrompt(project, t, { file: "mockup.json", ref: anchorRef, label });
    setText("");
    setOpen(false);
  };

  return (
    <div className="mu-inspectable" ref={wrapRef}>
      <button
        type="button"
        className="mu-chip"
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="message-square" size={11} />
        <span>{type}</span>
      </button>
      {open && (
        <div className="ask-popover mu-popover" onClick={(e) => e.stopPropagation()}>
          <div className="ask-label" title={label}>
            {label}
          </div>
          <textarea
            autoFocus
            rows={3}
            placeholder="Ask a question about this item…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="ask-popover-actions">
            <button className="mini-btn" onClick={() => setOpen(false)}>
              cancel
            </button>
            <button className="mini-btn primary" onClick={send}>
              ask
            </button>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

// ── dispatch type -> mockup-lib component (topbar/nav excluded: they're global chrome) ──

function RenderComponent({
  comp,
  pageId,
  pageName,
  project,
  theme,
  onNavigate,
  inModal = false,
}: {
  comp: MockupComponent;
  pageId: string;
  pageName: string;
  project: string;
  theme: MockupTheme;
  onNavigate: (target?: string) => void;
  // true when the component is rendered inside a kind='modal' page (see schemas/
  // mockup.schema.json). It only matters for the standard-theme rule "actions at the
  // bottom of a dialog: first button on the left, the rest on the right" (see the
  // 'actions' case below) — propagated recursively into tabs/section/sidebar-nav so it
  // still holds when nested.
  inModal?: boolean;
}) {
  const [activeTab, setActiveTab] = useState(0);
  const [activeSidenav, setActiveSidenav] = useState(0);
  const props: Record<string, any> = comp.props ?? {};
  let inner: ReactNode;

  switch (comp.type) {
    case "topbar":
    case "nav":
      // global chrome: handled separately by MockupDocument, renders nothing here
      inner = null;
      break;

    case "breadcrumb":
      // standard theme: automatic chrome, the 'Back' link is shown by PageTitle (see
      // MockupDocument below).
      inner = theme === "standard" ? null : <Breadcrumb items={props.items ?? []} onNavigate={onNavigate} />;
      break;

    case "kpi-row":
      inner = <KpiRow cards={props.cards ?? []} />;
      break;

    case "grid":
      inner = (
        <DataGrid
          title={props.title}
          columns={props.columns ?? []}
          rows={props.rows ?? []}
          actions={props.actions ?? []}
          searchable={props.searchable !== false}
          paginationLabel={props.paginationLabel}
          actionsPosition={gridActionsPosition(theme)}
          onNavigate={onNavigate}
        />
      );
      break;

    case "form":
      inner = (
        <FormSection
          title={props.title}
          fields={props.fields ?? []}
          submitLabel={props.submit_label}
          cancelLabel={props.cancel_label}
          onSubmit={() => onNavigate(props.submit_target)}
          onCancel={() => onNavigate(undefined)}
        />
      );
      break;

    case "detail":
      inner = <DetailView title={props.title} sections={props.sections ?? []} />;
      break;

    case "actions":
      // standard theme: inside a dialog the first button is isolated on the left (the
      // EXIT + rest pattern) — see schemas/mockup.schema.json c_actions and ActionsBar.tsx.
      inner = <ActionsBar buttons={props.buttons ?? []} onNavigate={onNavigate} splitFirst={theme === "standard" && inModal} />;
      break;

    case "banner":
      inner = <Banner style={props.style} title={props.title} text={props.text} />;
      break;

    case "section": {
      const children = (props.components ?? []).map((c: MockupComponent) => (
        <RenderComponent key={c.id} comp={c} pageId={pageId} pageName={pageName} project={project} theme={theme} onNavigate={onNavigate} inModal={inModal} />
      ));
      inner = (
        <Section title={props.title} icon={props.icon} collapsible={props.collapsible}>
          {children}
        </Section>
      );
      break;
    }

    case "tabs": {
      const tabs = props.tabs ?? [];
      const active = tabs[activeTab] ? activeTab : 0;
      const panels = tabs.map((t: any) => (
        <>
          {(t.components ?? []).map((c: MockupComponent) => (
            <RenderComponent key={c.id} comp={c} pageId={pageId} pageName={pageName} project={project} theme={theme} onNavigate={onNavigate} inModal={inModal} />
          ))}
        </>
      ));
      inner = (
        <TabsShell labels={tabs.map((t: any) => t.label)} active={active} onSelect={setActiveTab} panels={panels} />
      );
      break;
    }

    case "sidebar-nav": {
      const sections = props.sections ?? [];
      const active = sections[activeSidenav] ? activeSidenav : 0;
      const panels = sections.map((s: any) => (
        <>
          {(s.components ?? []).map((c: MockupComponent) => (
            <RenderComponent key={c.id} comp={c} pageId={pageId} pageName={pageName} project={project} theme={theme} onNavigate={onNavigate} inModal={inModal} />
          ))}
        </>
      ));
      inner = (
        <SidebarNav
          title={props.title ?? ""}
          labels={sections.map((s: any) => s.label)}
          active={active}
          onSelect={setActiveSidenav}
          info={props.info}
          alerts={props.alerts}
          panels={panels}
        />
      );
      break;
    }

    case "filters":
      inner = (
        <Filters theme={theme} fields={props.fields ?? []} collapsible={props.collapsible} searchLabel={props.search_label} />
      );
      break;

    case "legend":
      inner = <Legend title={props.title} items={props.items ?? []} />;
      break;

    case "statusbar":
      inner = <StatusBar label={props.label} tone={props.tone} icon={props.icon} />;
      break;

    case "wizard-steps":
      inner = <WizardSteps steps={props.steps ?? []} current={props.current} orientation={props.orientation} />;
      break;

    case "state-progress":
      inner = <StateProgress title={props.title} states={props.states ?? []} current={props.current} />;
      break;

    case "segmented":
      inner = <SegmentedToggle options={props.options ?? []} active={props.active ?? 0} onNavigate={onNavigate} />;
      break;

    case "tiles":
      inner = (
        <Tiles
          items={(props.items ?? []).map((it: any) => ({ label: it.label, icon: it.icon, linkLabel: it.link_label, target: it.target }))}
          onNavigate={onNavigate}
        />
      );
      break;

    default:
      inner = (
        <div className="mu-unknown">
          Unknown component: <code>{String(comp.type)}</code>
        </div>
      );
  }

  if (inner === null) return null;

  const page: MockupPage = { id: pageId, name: pageName, components: [] };
  return (
    <Inspectable project={project} anchorRef={anchorRefFor(pageId, comp.id)} label={anchorLabelFor(page, comp)} type={String(comp.type)}>
      {inner}
    </Inspectable>
  );
}

// ── finding the chrome (first topbar / first nav found while scanning the pages) ──

function findChrome(pages: MockupPage[]): {
  topbar: { pageId: string; comp: MockupComponent } | null;
  nav: { pageId: string; comp: MockupComponent } | null;
} {
  let topbar: { pageId: string; comp: MockupComponent } | null = null;
  let nav: { pageId: string; comp: MockupComponent } | null = null;
  for (const p of pages) {
    for (const c of p.components) {
      if (c.type === "topbar" && !topbar) topbar = { pageId: p.id, comp: c };
      if (c.type === "nav" && !nav) nav = { pageId: p.id, comp: c };
    }
    if (topbar && nav) break;
  }
  return { topbar, nav };
}

// ── the whole document ──────────────────────────────────────────────────────

export default function MockupView({ project, tick }: { project: string; tick: number }) {
  const [doc, setDoc] = useState<MockupDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [pageId, setPageId] = useState<string | null>(null);
  // The 'modal' page currently open as an overlaid dialog (null = no dialog open).
  // See schemas/mockup.schema.json: pages[].kind === "modal".
  const [modalPageId, setModalPageId] = useState<string | null>(null);
  const hasLoaded = useRef(false);
  // One effect for both "project changed" and "tick changed", with the decision itself in
  // lib/reloadDecision.ts (shared with the other views and unit-tested there), plus a request
  // id so a slow response for a project you've since left cannot land on top of whatever
  // loaded after it.
  const prevProject = useRef(project);
  const lastSeenTick = useRef(tick);
  const requestId = useRef(0);

  const firstNavigablePageId = (pages: MockupPage[]): string | null =>
    pages.find((p) => p.kind !== "modal")?.id ?? pages[0]?.id ?? null;

  const load = () => {
    const id = ++requestId.current;
    return apiClient
      .getDoc(project, "mockup")
      .then((d) => {
        if (id !== requestId.current) return;
        setDoc(d);
        setError(null);
        setNotFound(false);
        setModalPageId(null);
        setPageId((cur) =>
          cur && d.pages.some((p) => p.id === cur && p.kind !== "modal") ? cur : firstNavigablePageId(d.pages)
        );
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
      setPageId(null);
      setModalPageId(null);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tick]);

  // Esc closes the open dialog, if there is one.
  useEffect(() => {
    if (!modalPageId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalPageId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalPageId]);

  const { topbar, nav } = useMemo(() => (doc ? findChrome(doc.pages) : { topbar: null, nav: null }), [doc]);
  const modalPageIds = useMemo(
    () => new Set((doc?.pages ?? []).filter((p) => p.kind === "modal").map((p) => p.id)),
    [doc]
  );

  if (error) return <div className="viewer-empty">Mockup load error: {error}</div>;
  if (notFound)
    return (
      <div className="viewer-empty">
        No mockup has been generated for this project.
        <br />
        Use the <code>mockup</code> skill (the "generate" button in the Output bar) to create one.
      </div>
    );
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;
  if (!doc.pages.length) return <div className="viewer-empty">The mockup has no pages yet.</div>;

  const page =
    doc.pages.find((p) => p.id === pageId && p.kind !== "modal") ??
    doc.pages.find((p) => p.kind !== "modal") ??
    doc.pages[0];
  const theme = themeOf(doc.meta.theme);
  let bodyComponents = page.components.filter((c) => c.type !== "topbar" && c.type !== "nav");

  // If the FIRST component of the page is 'actions', the compact theme hoists it next to
  // the title (record view header) instead of leaving it in the body — see
  // schemas/mockup.schema.json.
  let hoistedActions: MockupComponent | null = null;
  if (theme === "compact" && bodyComponents[0]?.type === "actions") {
    hoistedActions = bodyComponents[0];
    bodyComponents = bodyComponents.slice(1);
  }

  // standard theme: the 'Back' link is automatic chrome derived from the page's
  // 'breadcrumb' component (the second-to-last item), shown by PageTitle. The breadcrumb
  // component itself renders nothing in the body for this theme (see RenderComponent case
  // "breadcrumb").
  let backTarget: string | undefined;
  if (theme === "standard") {
    const bc = bodyComponents.find((c) => c.type === "breadcrumb");
    const items: { label: string; page?: string }[] = bc?.props?.items ?? [];
    const back = items.length >= 2 ? items[items.length - 2] : items[0];
    backTarget = back?.page;
  }

  // compact theme: automatic 2-column record view (see lib/mockupTheme.ts for the rule and
  // its tests).
  const { side: sideComponents, main: sideMainComponents } = splitRecordViewSide(theme, bodyComponents);
  bodyComponents = sideMainComponents;

  // A target pointing at a kind='modal' page opens the dialog instead of navigating; a
  // target pointing at a normal page closes any open dialog and navigates (even when the
  // button is inside the dialog itself — see schemas/mockup.schema.json).
  const onNavigate = (target?: string) => {
    // no target = "cancel" (a form's cancel button, say): if a modal is open it closes it,
    // otherwise it does nothing (cancel on a normal page has no destination).
    if (!target) { setModalPageId(null); return; }
    const targetPage = doc.pages.find((p) => p.id === target);
    if (!targetPage) return;
    if (targetPage.kind === "modal") {
      setModalPageId(target);
      return;
    }
    setModalPageId(null);
    setPageId(target);
  };

  const pageNameOf = (id: string) => doc.pages.find((p) => p.id === id)?.name ?? id;

  const topbarNode = topbar ? (
    <Inspectable
      project={project}
      anchorRef={anchorRefFor(topbar.pageId, topbar.comp.id)}
      label={anchorLabelFor({ id: topbar.pageId, name: pageNameOf(topbar.pageId), components: [] }, topbar.comp)}
      type="topbar"
    >
      <Topbar theme={theme} title={topbar.comp.props?.title ?? ""} user={topbar.comp.props?.user ?? ""} />
    </Inspectable>
  ) : null;

  // 'modal' pages never show up in nav (they aren't directly navigable).
  const navItems = (nav?.comp.props?.items ?? []).filter((it: { page?: string }) => !modalPageIds.has(it.page ?? ""));
  const navNode = nav ? (
    <Inspectable
      project={project}
      anchorRef={anchorRefFor(nav.pageId, nav.comp.id)}
      label={anchorLabelFor({ id: nav.pageId, name: pageNameOf(nav.pageId), components: [] }, nav.comp)}
      type="nav"
    >
      <NavMenu theme={theme} items={navItems} currentPageId={page.id} onNavigate={onNavigate} />
    </Inspectable>
  ) : null;

  const hoistedActionsNode = hoistedActions ? (
    <RenderComponent comp={hoistedActions} pageId={page.id} pageName={page.name} project={project} theme={theme} onNavigate={onNavigate} />
  ) : undefined;

  const renderBodyComponent = (c: MockupComponent) => (
    <RenderComponent key={c.id} comp={c} pageId={page.id} pageName={page.name} project={project} theme={theme} onNavigate={onNavigate} />
  );

  // standard/plain: the nav goes INSIDE the page content, right under the title (see
  // AppShell — it's no longer standalone chrome). compact: it stays in the sidebar, passed
  // to AppShell.
  const pageInner = (
    <>
      <PageTitle theme={theme} title={page.name} backTarget={backTarget} onNavigate={onNavigate} actionsSlot={hoistedActionsNode} />
      {theme !== "compact" && navNode}
      {sideComponents.length > 0 ? (
        <div className="mk-record-view-cols">
          <aside className="mk-record-view-side">{sideComponents.map(renderBodyComponent)}</aside>
          <div className="mk-record-view-main">{bodyComponents.map(renderBodyComponent)}</div>
        </div>
      ) : (
        bodyComponents.map(renderBodyComponent)
      )}
    </>
  );

  const modalPage = modalPageId ? doc.pages.find((p) => p.id === modalPageId) : null;
  const modalComponents = modalPage ? modalPage.components.filter((c) => c.type !== "topbar" && c.type !== "nav") : [];

  // Rendered INSIDE AppShell (see the 'modal' prop): that way it inherits the theme's CSS
  // custom properties (--mk-primary and friends) and the .mk-shell-{theme} .mk-modal-*
  // rules, instead of being a sibling outside the themed div.
  const modalNode = modalPage ? (
    <div className="mk-modal-overlay" onClick={() => setModalPageId(null)}>
      <div className="mk-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="mk-modal-header">
          <h2 className="mk-modal-title">{modalPage.name}</h2>
          <button type="button" className="mk-modal-close" aria-label="Close" onClick={() => setModalPageId(null)}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="mk-modal-body">
          {modalComponents.map((c) => (
            <RenderComponent
              key={c.id}
              comp={c}
              pageId={modalPage.id}
              pageName={modalPage.name}
              project={project}
              theme={theme}
              onNavigate={onNavigate}
              inModal
            />
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="mu-outer">
      <AppShell
        theme={theme}
        topbar={topbarNode}
        nav={theme === "compact" ? navNode : null}
        modal={modalNode}
        title={topbar?.comp.props?.title}
      >
        {pageInner}
      </AppShell>
    </div>
  );
}
