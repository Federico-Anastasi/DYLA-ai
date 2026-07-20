import { FieldGridView, type ViewField } from "./FieldGrid";

// Read-only detail view (schema type 'detail'): a title plus N sections, each with an optional
// title and a label/value grid. One section = one card, coloured by the active theme. The section
// title is optional on purpose: leave it out when the 'detail' sits inside a collapsible 'section'
// that already shows the title (the dialog + 'sidebar-nav' pattern), to avoid a doubled heading.
export function DetailView({ title, sections }: { title?: string; sections: { title?: string; fields: ViewField[] }[] }) {
  return (
    <div className="mk-detail-block">
      {title && <div className="mk-card-title mk-detail-title">{title}</div>}
      {sections.map((sec, si) => (
        <div className="mk-card mk-detail-section" key={si}>
          {sec.title && <h4>{sec.title}</h4>}
          <FieldGridView fields={sec.fields} />
        </div>
      ))}
    </div>
  );
}
