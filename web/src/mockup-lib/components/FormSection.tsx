import { FieldGridEdit, type FormField } from "./FieldGrid";

// Create/edit form (schema type 'form'): optional title + grid of editable fields + a submit/cancel
// button row. It is a single card, with border/shadow/radius coming from the theme.
export function FormSection({
  title,
  fields,
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: {
  title?: string;
  fields: FormField[];
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  return (
    <div className="mk-card mk-form-card">
      {title && <div className="mk-card-title">{title}</div>}
      <FieldGridEdit fields={fields} />
      <div className="mk-actions-row mk-form-actions">
        {cancelLabel && (
          <button type="button" className="mk-btn mk-btn-secondary" onClick={() => onCancel?.()}>
            {cancelLabel}
          </button>
        )}
        <button type="button" className="mk-btn mk-btn-primary" onClick={() => onSubmit()}>
          {submitLabel || "Save"}
        </button>
      </div>
    </div>
  );
}
