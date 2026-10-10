import type { ReactNode } from "react";

export type MachineRow = {
  id: string;
  importance: number;
  label: string;
  value: string;
  detail: string | null;
  tone: "normal" | "warning" | "danger";
  action: { id: string; label: string } | null;
  children: MachineRow[];
};

export function orderedRows(rows: readonly MachineRow[]): MachineRow[] {
  return [...rows].sort((a, b) => b.importance - a.importance);
}

export function MachineRows({ rows, onAction }: { rows: readonly MachineRow[]; onAction?(id: string): void }) {
  function contents(row: MachineRow): ReactNode {
    return <><span className="machine-row-heading"><strong>{row.label}</strong><span>{row.value}</span></span>
      {row.detail !== null && <small>{row.detail}</small>}
      {row.action !== null && <button type="button" onClick={() => onAction?.(row.action!.id)}>{row.action.label}</button>}</>;
  }
  return <ul className="machine-rows">{orderedRows(rows).map(row => <li key={row.id} className="machine-row" data-importance={row.importance} data-tone={row.tone}>
    {row.children.length ? <details><summary>{contents({ ...row, action: null })}</summary>{row.action !== null && <button type="button" onClick={() => onAction?.(row.action!.id)}>{row.action.label}</button>}<MachineRows rows={row.children} onAction={onAction} /></details> : contents(row)}
  </li>)}</ul>;
}
