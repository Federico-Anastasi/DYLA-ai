// Mockup component library, themed (standard/compact/plain). Barrel file: it re-exports every
// component plus the shared types. The "type string -> component" dispatch deliberately stays in
// web/src/components/Viewer/MockupView.tsx and not here, because some types ('tabs', 'section')
// recurse into nested components and each child has to be wrapped in the "ask Dyla" Inspectable.
// MockupView owns that mechanism; the library stays a pure dumb render.
//
// The 19 schema types covered (see schemas/mockup.schema.json). The page title (PageTitle) is not a
// schema type of its own: it is chrome derived automatically from pages[].name:
// topbar, nav, breadcrumb, kpi-row, grid, form, detail, actions, tabs, banner,
// section, filters, legend, statusbar, wizard-steps, state-progress, segmented, tiles, sidebar-nav.
export * from "./components/AppShell";
export * from "./components/PageTitle";
export * from "./components/Breadcrumb";
export * from "./components/KpiRow";
export * from "./components/DataGrid";
export * from "./components/FieldGrid";
export * from "./components/FormSection";
export * from "./components/DetailView";
export * from "./components/ActionsBar";
export * from "./components/Tabs";
export * from "./components/Banner";
export * from "./components/Section";
export * from "./components/Filters";
export * from "./components/Legend";
export * from "./components/StatusBar";
export * from "./components/WizardSteps";
export * from "./components/StateProgress";
export * from "./components/SegmentedToggle";
export * from "./components/Tiles";
export * from "./components/SidebarNav";
export { Icon } from "./icons";
