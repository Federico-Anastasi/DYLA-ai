// Field grid in two modes: "edit" (real inputs, for the form component) and "view" (read-only
// label/value pairs, for the detail component). They share one file so the styling — small bold
// label on top, spacing, input radius — stays identical everywhere.
export type FormField = {
  label: string;
  type: "text" | "number" | "date" | "select" | "textarea" | "checkbox";
  required?: boolean;
  options?: string[];
  placeholder?: string;
};

export type ViewField = { label: string; value: string };

function EditField(f: FormField, key: number) {
  const req = f.required ? <span className="mk-req">*</span> : null;
  if (f.type === "select") {
    return (
      <div className="mk-form-field" key={key}>
        <label>
          {f.label}
          {req}
        </label>
        <select defaultValue="">
          <option value="">Select...</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (f.type === "checkbox") {
    return (
      <div className="mk-form-field mk-form-field-checkbox" key={key}>
        <label>
          <input type="checkbox" /> {f.label}
          {req}
        </label>
      </div>
    );
  }
  if (f.type === "textarea") {
    return (
      <div className="mk-form-field mk-form-field-wide" key={key}>
        <label>
          {f.label}
          {req}
        </label>
        <textarea rows={3} placeholder={f.placeholder ?? ""} />
      </div>
    );
  }
  const inputType = f.type === "date" ? "date" : f.type === "number" ? "number" : "text";
  return (
    <div className="mk-form-field" key={key}>
      <label>
        {f.label}
        {req}
      </label>
      <input type={inputType} placeholder={f.placeholder ?? ""} />
    </div>
  );
}

export function FieldGridEdit({ fields }: { fields: FormField[] }) {
  return <div className="mk-form-grid">{fields.map((f, i) => EditField(f, i))}</div>;
}

export function FieldGridView({ fields }: { fields: ViewField[] }) {
  return (
    <div className="mk-detail-fields">
      {fields.map((f, i) => (
        <div className="mk-detail-field" key={i}>
          <div className="mk-df-label">{f.label}</div>
          <div className="mk-df-value">{f.value}</div>
        </div>
      ))}
    </div>
  );
}
