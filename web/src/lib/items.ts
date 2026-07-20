// The plannable items extracted from estimate.json: the dev tasks plus the E2E test rows.
// They live here because both the distribution and the rendering need them (see lib/lanes.ts).

import type { EstimateDoc } from "../types";

// Layer assigned to dev tasks generated before the field existed: 3 is the most populated
// layer and the most conservative one (it does not pull forward work that depends on
// something else).
export const LAYER_DEFAULT = 3;
export const LAYER_E2E = 4;

export type PlanItem = {
  id: string;
  name: string;
  description: string;
  days: number;
  layer: number;
  epicId: string;
  epicName: string;
  taskId: string | null; // null for E2E rows, which do not belong to a task
  taskName: string | null;
};

/** Flattens estimate.json into the schedulable items: dev tasks plus E2E rows. */
export function extractItems(estimate: EstimateDoc): PlanItem[] {
  const items: PlanItem[] = [];
  for (const epic of estimate.epics) {
    for (const task of epic.tasks) {
      for (const dt of task.dev_tasks ?? []) {
        items.push({
          id: dt.id,
          name: dt.dev_task,
          description: dt.description,
          days: dt.days,
          layer: dt.layer ?? LAYER_DEFAULT,
          epicId: epic.id,
          epicName: epic.name,
          taskId: task.id,
          taskName: task.task,
        });
      }
    }
    if (epic.e2e) {
      items.push({
        id: `${epic.id}.E2E`,
        name: epic.e2e.label,
        description: "",
        days: epic.e2e.days,
        layer: LAYER_E2E,
        epicId: epic.id,
        epicName: epic.name,
        taskId: null,
        taskName: null,
      });
    }
  }
  return items;
}
