// Board write convention — mirrors the app's lib/board/columns.ts column model.
// Open issues live in a status:* label column (backlog = absence of a status
// label); closed issues are Done. So backlog and done carry no status label.
export const STATUS_PREFIX = "status:";

export type ColumnKey = "backlog" | "todo" | "doing" | "review" | "done";
const COLUMNS: ColumnKey[] = ["backlog", "todo", "doing", "review", "done"];
const LABELED_COLUMNS: ColumnKey[] = ["todo", "doing", "review"];

export interface LabelSeed {
  name: string;
  color: string;
}

export const STATUS_LABEL_SEED: LabelSeed[] = [
  { name: "status:todo", color: "c5def5" },
  { name: "status:doing", color: "fbca04" },
  { name: "status:review", color: "d4c5f9" },
];

export function isValidColumn(key: string): key is ColumnKey {
  return (COLUMNS as string[]).includes(key);
}

export function labelForColumn(key: ColumnKey): string | null {
  return LABELED_COLUMNS.includes(key) ? `${STATUS_PREFIX}${key}` : null;
}

export function statusLabelsOn(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith(STATUS_PREFIX));
}

export function targetState(key: ColumnKey): "open" | "closed" {
  return key === "done" ? "closed" : "open";
}

export interface MovePlan {
  remove: string[];
  add: string | null;
  state: "open" | "closed";
}

export function computeMove(currentLabels: string[], target: ColumnKey): MovePlan {
  return {
    remove: statusLabelsOn(currentLabels),
    add: labelForColumn(target),
    state: targetState(target),
  };
}
