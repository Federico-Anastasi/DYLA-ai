import { Icon } from "../icons";

// Stepped wizard (schema type 'wizard-steps'). steps = the labels, current = the active step
// (1-based): earlier steps are 'done' (check mark), the current one is 'active', later ones 'todo'.
// Horizontal up to 7 steps and vertical beyond that, unless orientation is set explicitly.
export function WizardSteps({ steps, current, orientation }: { steps: string[]; current: number; orientation?: "horizontal" | "vertical" }) {
  const layout = orientation ?? (steps.length <= 7 ? "horizontal" : "vertical");
  return (
    <div className={`mk-wizard mk-wizard-${layout}`}>
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "active" : "todo";
        return (
          <div className={`mk-wizard-step mk-wizard-step-${state}`} key={i}>
            <span className="mk-wizard-circle">{state === "done" ? <Icon name="check" size={16} /> : n}</span>
            <span className="mk-wizard-label">{label}</span>
            {i < steps.length - 1 && <span className="mk-wizard-connector" />}
          </div>
        );
      })}
    </div>
  );
}
