import type { Dashboard, PlanAccountRow } from "../../../../server/protocol";
import { formatBytes, formatDollars, formatLocalDateTime, formatShare, formatTokens, formatWeekReset } from "./format";
import { MachineRows, type MachineRow } from "./rows";
import "./machine.css";

export type MachineScreenProps = {
  dashboard: Dashboard | null;
  modelCounts: Map<string, number>;
  ownerErrors: { id: string; owner: string; message: string }[];
  offline: string;
  syncing: boolean;
  onDismissOwnerError(id: string): void;
  onReconnect(): void;
  features: MachineRow[];
  clientRevision: string;
};

export function machineRow(id: string, importance: number, label: string, value: string, detail: string | null = null, children: MachineRow[] = []): MachineRow {
  return { id, importance, label, value, detail, children, tone: "normal", action: null };
}

function accountRow(account: PlanAccountRow): MachineRow {
  const reading = formatLocalDateTime(account.readingAt);
  const reset = formatLocalDateTime(account.resetAt);
  return machineRow(account.accountId, 0, account.accountLabel,
    account.state === "unavailable" || account.percentLeft === null ? "Usage unavailable" : `${account.percentLeft}% remaining${account.state === "stale" ? " · stale" : ""}`,
    [reading && `Read ${reading}`, reset && `Resets ${reset}`, account.bankedResets !== null && `${account.bankedResets} banked resets`, account.bankedResetExpiresAt && `First expires ${formatLocalDateTime(account.bankedResetExpiresAt)}`].filter(Boolean).join(" · ") || null);
}

export function machineRows(props: MachineScreenProps): MachineRow[] {
  const rows: MachineRow[] = props.ownerErrors.map(error => ({ ...machineRow(`error:${error.id}`, 100, error.owner, error.message), tone: "danger", action: { id: `dismiss:${error.id}`, label: "Dismiss" } }));
  rows.push({ ...machineRow("connection", props.offline ? 100 : 60, "Connection", props.offline || (props.syncing ? "Syncing" : "Connected")), tone: props.offline ? "danger" : "normal", action: props.offline ? { id: "reconnect", label: "Reconnect" } : null });
  const dashboard = props.dashboard;
  if (dashboard === null) {
    rows.push(machineRow("dashboard", 80, "Usage", "Not loaded"));
  } else {
    if (dashboard.allowance !== null) {
      const allowance = dashboard.allowance;
      const exhausted = allowance.usedUsd >= allowance.weeklyUsd;
      rows.push({ ...machineRow("allowance", exhausted ? 95 : 85, "Your weekly limit", `${formatDollars(allowance.usedUsd)} / ${formatDollars(allowance.weeklyUsd)}`, `${exhausted ? "Used up" : `${formatDollars(allowance.weeklyUsd - allowance.usedUsd)} left`} · resets ${formatWeekReset(allowance.resetsAt)}`), tone: exhausted ? "danger" : "normal" });
    }
    const spending = dashboard.plans.flatMap(plan => plan.spent === null ? [] : [plan.spent]);
    if (spending.length) rows.push(machineRow("spend", 85, "Your model usage", `${formatDollars(spending.reduce((sum, value) => sum + value.day, 0))} today`, `${formatDollars(spending.reduce((sum, value) => sum + value.week, 0))} this week · subscription usage`, dashboard.plans.flatMap(plan => plan.spent === null ? [] : [machineRow(`spend:${plan.id}`, 0, plan.label, `${formatDollars(plan.spent.day)} today`, `${formatDollars(plan.spent.week)} this week`)])));
    for (const plan of dashboard.plans) {
      for (const metric of plan.metrics) {
        const match = metric.text.match(/(\d+(?:\.\d+)?)\s*%/);
        const remaining = match === null ? null : Number(match[1]);
        rows.push({ ...machineRow(`quota:${plan.id}:${metric.id}`, remaining !== null && remaining < 15 ? 90 : 80, `${plan.label} · ${metric.modelLabel}`, metric.text === "—" ? "Usage unavailable" : metric.text,
          [metric.description, `${props.modelCounts.get(metric.model) ?? 0} active`, metric.cacheText && `${metric.cacheText} cached · 24h`].filter(Boolean).join(" · "), metric.accounts.map(accountRow)), tone: remaining === null ? "warning" : remaining < 15 ? "danger" : remaining < 35 ? "warning" : "normal" });
      }
    }
    if (dashboard.people !== null) {
      const periods = (["day", "week"] as const).map(period => {
        const usage = dashboard.people!.periods[period];
        return machineRow(period, 0, period === "day" ? "Last 24 hours" : "Last 7 days", `${formatDollars(usage.used)} used / ${formatDollars(usage.spend)} subscriptions`, null,
          usage.people.map(person => machineRow(person.user, 0, person.name, `${formatDollars(person.spend)} · ${formatShare(person.percent)}`, `${formatTokens(person.tokens)} tokens · ${formatDollars(person.value)} at API prices${person.workersPercent === null ? "" : ` · ${formatShare(person.workersPercent)} background workers`}`)));
      });
      rows.push(machineRow("people", 30, "People", "Subscription usage", null, periods));
    }
    const machine = dashboard.machine;
    const percent = (value: number | null) => value === null ? "Not measured" : `${Math.round(value)}%`;
    rows.push(machineRow("host", 20, "Host", machine === null ? "Not measured" : "Resource usage", null, machine === null ? [] : [
      machineRow("cpu", 0, "CPU", percent(machine.cpuPercent)),
      machineRow("gpu", 0, "GPU", percent(machine.gpuPercent)),
      machineRow("ram", 0, "RAM", percent(machine.memory.percentUsed), `${formatBytes(machine.memory.usedBytes)} / ${formatBytes(machine.memory.totalBytes)}`),
      machineRow("disk", 0, "Disk", percent(machine.disk?.percentUsed ?? null), machine.disk === null ? null : `${formatBytes(machine.disk.usedBytes)} / ${formatBytes(machine.disk.totalBytes)}`),
    ]));
  }
  rows.push(...props.features, machineRow("revision", 0, "App revision", props.clientRevision.slice(0, 12), props.clientRevision));
  return rows;
}

export function MachineScreen(props: MachineScreenProps) {
  const action = (id: string) => {
    if (id === "reconnect") return props.onReconnect();
    if (id.startsWith("dismiss:") && id.length > "dismiss:".length) return props.onDismissOwnerError(id.slice("dismiss:".length));
    throw new Error(`Unknown Machine action: ${id}`);
  };
  return <main className="machine-screen"><MachineRows rows={machineRows(props)} onAction={action} /></main>;
}
