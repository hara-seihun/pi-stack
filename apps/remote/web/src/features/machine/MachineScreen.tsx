import { useEffect, useState, type ReactNode } from "react";
import type { Dashboard, Governor, GovernorProvider, GovernorState, MachineUsage, PeopleUsage, PeopleUsagePeriod, PlanAccountRow, PlanCard, PlanMetricRow } from "../../../../server/protocol";
import { Sheet } from "../../app/Sheet";
import { iconUrl } from "../../chat-row";
import { formatBytes, formatDollars, formatLocalDateTime, formatResetDistance, formatShare, formatTokens } from "./format";
import "./machine.css";

export type MachineScreenProps = {
  dashboard: Dashboard | null;
  modelCounts: Map<string, number>;
  ownerErrors: { id: string; owner: string; message: string }[];
  offline: string;
  syncing: boolean;
  pendingAction: string | null;
  onToggleAction(id: string): void;
  onToggleGovernor(provider: GovernorProvider): void;
  onDismissOwnerError(id: string): void;
  onReconnect(): void;
  environment: ReactNode;
  notifications: ReactNode;
  appUpdate: ReactNode;
  clientRevision: string;
};

const governorModes: GovernorState[] = ["off", "green", "blue", "red"];

function governorModeLabel(mode: GovernorState, governor: Governor): string {
  if (mode === "off") return "Normal";
  if (mode === "green") return "3×";
  if (mode === "blue") return `${governor.boostedMultiplier}×`;
  return "Halted";
}

function nextGovernorMode(governor: Governor): GovernorState {
  return governorModes[(governorModes.indexOf(governor.state) + 1) % governorModes.length]!;
}

function percentage(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function risk(value: number): "danger" | "warning" | "accent" {
  return value < 15 ? "danger" : value < 35 ? "warning" : "accent";
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <section className="machine-card"><h2>{title}</h2>{children}</section>;
}

function numericPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function quotaWindow(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24}-day quota` : `${hours}-hour quota`;
}

/** Banked resets each return one quota window to zero when they are spent. */
function bankedResets(account: PlanAccountRow) {
  if (account.bankedResets === null) return null;
  const expires = formatLocalDateTime(account.bankedResetExpiresAt);
  return <><dt>Banked resets</dt><dd>
    <strong>{account.bankedResets === 0 ? "None" : account.bankedResets === 1 ? "1 reset" : `${account.bankedResets} resets`}</strong>
    {account.bankedResets > 0 && expires && <small>First expires {expires}</small>}
  </dd></>;
}

function PlanAccount({ account, now }: { account: PlanAccountRow; now: number }) {
  const readingAt = formatLocalDateTime(account.readingAt);
  const resetAt = formatLocalDateTime(account.resetAt);
  const banked = bankedResets(account);
  return <article className="machine-account">
    <header>
      <div><strong>{account.accountLabel}</strong>{account.accountLabel !== account.accountId && <small>{account.accountId}</small>}</div>
      <span>{account.percentLeft === null ? "Usage unavailable" : account.state === "stale" ? `Last reported ${numericPercent(account.percentLeft)}% remaining` : `${numericPercent(account.percentLeft)}% remaining`}</span>
    </header>
    {account.state === "unavailable" ? <>
      <p>No usable usage reading is available for this account.</p>
      {banked && <dl>{banked}</dl>}
    </> : <>
      {account.state === "stale" && <p>This reading is too old for the aggregate.</p>}
      <dl>
        {account.windowHours !== null && <><dt>Quota</dt><dd>{quotaWindow(account.windowHours)}</dd></>}
        {readingAt && <><dt>{account.state === "stale" ? "Last read" : "Read"}</dt><dd>{readingAt}</dd></>}
        <dt>Resets</dt><dd>{resetAt ? <><strong>{resetAt}</strong><small>{formatResetDistance(account.resetAt, now)}</small></> : formatResetDistance(null, now)}</dd>
        {banked}
      </dl>
    </>}
  </article>;
}

function PlanDetail({ plan, metric, now, onClose }: { plan: PlanCard; metric: PlanMetricRow | null; now: number; onClose(): void }) {
  return <Sheet open={metric !== null} title={metric ? `${plan.label} ${metric.modelLabel}` : plan.label} onClose={onClose}>
    {metric && <div className="machine-plan-detail">
      <header><strong>{metric.text === "—" ? "Usage unavailable" : metric.text}</strong><span>{metric.description}</span></header>
      {metric.accounts.length === 0 ? <p className="machine-secondary">No accounts are configured for this plan.</p> : metric.accounts.map((account) => <PlanAccount key={account.accountId} account={account} now={now} />)}
    </div>}
  </Sheet>;
}

function Plan({ plan, modelCounts }: { plan: PlanCard; modelCounts: Map<string, number> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const metrics = plan.metrics.filter((metric) => metric.text !== "—" || metric.accounts.length > 0);
  const [now, setNow] = useState(Date.now());
  const selected = plan.metrics.find((metric) => metric.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [selectedId, selected]);
  return <>
    <Card title={<span className="machine-provider"><img src={iconUrl(plan.icon)} alt={`${plan.label} plan`} title={plan.label} /></span>}>
      {plan.description && <p className="machine-secondary">{plan.description}</p>}
      {metrics.map((metric) => {
        const remaining = percentage(metric.text);
        const active = modelCounts.get(metric.model) ?? 0;
        return <div className="machine-plan-row" key={metric.id}>
          <div className="machine-plan-heading"><div className="machine-plan-name"><strong>{metric.modelLabel}</strong><small>{metric.description}</small></div><span>{metric.text === "—" ? "Usage unavailable" : metric.text}</span></div>
          {remaining !== null ? <button type="button" className="machine-bar" aria-label={`${metric.modelLabel}, ${metric.description}: ${remaining}% remaining. Show account quota details.`} onClick={() => setSelectedId(metric.id)}><span data-risk={risk(remaining)} style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }} /></button> : metric.accounts.length > 0 && <button type="button" className="machine-plan-details-button" onClick={() => setSelectedId(metric.id)}>View account details</button>}
          <div className="machine-plan-meta"><span>{active} active</span>{metric.cacheText && <span>{metric.cacheText} cached · 24h</span>}</div>
        </div>;
      })}
      {plan.spent && <div className="machine-plan-spent" aria-label={`You used ${formatDollars(plan.spent.day)} of ${plan.label} in the last 24 hours and ${formatDollars(plan.spent.week)} in the last 7 days`}>
        <span>You used</span><strong>{formatDollars(plan.spent.day)}</strong><small>24h</small><strong>{formatDollars(plan.spent.week)}</strong><small>7 days</small>
      </div>}
    </Card>
    <PlanDetail plan={plan} metric={selected} now={now} onClose={() => setSelectedId(null)} />
  </>;
}

const peoplePeriods: Array<{ id: PeopleUsagePeriod; label: string; description: string }> = [
  { id: "day", label: "Day", description: "last 24 hours" },
  { id: "week", label: "Week", description: "last 7 days" },
];

/** Everyone's part of what the host's subscriptions cost. Each provider has one
 * trailing-week rate of subscription dollars per list-price dollar, so a Fable token and a Luna
 * token are not counted as the same thing, and one provider's prices never
 * move the other provider's bill. */
export function People({ usage }: { usage: PeopleUsage }) {
  const [period, setPeriod] = useState<PeopleUsagePeriod>("day");
  const current = usage.periods[period];
  const selected = peoplePeriods.find((item) => item.id === period)!;
  return <Card title="People">
    <div className="machine-people-header">
      <p className="machine-secondary">{formatDollars(current.used)} used of {formatDollars(current.spend)} in subscriptions, {selected.description}</p>
      <div className="machine-people-periods" role="group" aria-label="Usage period">
        {peoplePeriods.map((item) => <button key={item.id} type="button" aria-pressed={period === item.id} onClick={() => setPeriod(item.id)}>{item.label}</button>)}
      </div>
    </div>
    {current.subscriptions.length > 0 && <p className="machine-people-plans">{current.subscriptions.map((plan) => `${plan.label} ${plan.accounts} × $${plan.monthlyUsd}/mo = ${formatDollars(plan.spend)}${plan.idle ? " unused" : ""}`).join(" · ")}</p>}
    {current.people.length === 0 ? <p className="machine-secondary">Nobody used a model in this period.</p> : current.people.map((person) => <div className="machine-plan-row machine-person" key={person.user}>
      <div className="machine-plan-heading"><div className="machine-plan-name"><strong>{person.name}</strong></div><span>{formatDollars(person.spend)} · {formatShare(person.percent)}</span></div>
      <div className="machine-bar machine-person-bar" role="img" aria-label={`${person.name}: ${formatDollars(person.spend)}, ${formatShare(person.percent)} of subscription spending`}><span style={{ width: `${Math.max(0.5, Math.min(100, person.percent))}%` }} /></div>
      <div className="machine-plan-meta"><span>{formatTokens(person.tokens)} tokens · {formatDollars(person.value)} at API prices</span>{person.workersPercent !== null && <span>{formatShare(person.workersPercent)} workers</span>}</div>
    </div>)}
  </Card>;
}

function Host({ machine }: { machine: MachineUsage | null }) {
  if (!machine) return <Card title="Host"><p className="machine-secondary">Not measured</p></Card>;
  return <Card title="Host"><div className="machine-usage-grid">
    <UsageTile label="CPU" percent={machine.cpuPercent} />
    <UsageTile label="GPU" percent={machine.gpuPercent} />
    <UsageTile label="RAM" percent={machine.memory.percentUsed} detail={`${formatBytes(machine.memory.usedBytes)} / ${formatBytes(machine.memory.totalBytes)}`} />
    <UsageTile label="Disk" percent={machine.disk?.percentUsed ?? null} detail={machine.disk ? `${formatBytes(machine.disk.usedBytes)} / ${formatBytes(machine.disk.totalBytes)}` : undefined} />
  </div></Card>;
}

function UsageTile({ label, percent, detail }: { label: string; percent: number | null; detail?: string }) {
  return <div className="machine-usage-tile"><span>{label}</span><strong>{percent === null ? "Not measured" : `${Math.round(percent)}%`}</strong>{detail && <small>{detail}</small>}</div>;
}

export function MachineScreen(props: MachineScreenProps) {
  const { dashboard } = props;
  return <main className="machine-screen">
    <div className="machine-grid">
      {dashboard?.plans.map((plan) => <Plan key={plan.id} plan={plan} modelCounts={props.modelCounts} />)}
      {dashboard?.people && <People usage={dashboard.people} />}
      {dashboard?.governors && <Card title="Background launch pace">
        {(["openai", "anthropic"] as const).map((provider) => {
          const governor = dashboard.governors![provider];
          const pending = props.pendingAction === provider;
          const current = governorModeLabel(governor.state, governor);
          const next = governorModeLabel(nextGovernorMode(governor), governor);
          const providerLabel = provider === "openai" ? "OpenAI" : "Anthropic";
          return <div className="machine-governor" key={provider}>
            <strong>{providerLabel}</strong>
            <button type="button" disabled={pending} aria-label={`${providerLabel} background launch pace is ${current}. Change to ${next}.`} title={`Change ${providerLabel} from ${current} to ${next}`} onClick={() => props.onToggleGovernor(provider)}>{pending ? "Changing…" : `${current} → ${next}`}</button>
          </div>;
        })}
      </Card>}
      {dashboard && dashboard.actions.length > 0 && <Card title="Actions"><div className="machine-actions">
        {dashboard.actions.map((action) => {
          const pending = props.pendingAction === action.id;
          return <button className="machine-action" type="button" role="switch" aria-checked={action.active} disabled={pending} onClick={() => props.onToggleAction(action.id)} key={action.id}><span>{action.label}</span><strong>{pending ? "Saving…" : action.active ? "On" : "Off"}</strong></button>;
        })}
      </div></Card>}
      <Host machine={dashboard?.machine ?? null} />
      <Card title="Environment">{props.environment}</Card>
      <Card title="Notifications">{props.notifications}</Card>
      <Card title="App">{props.appUpdate}<dl className="machine-app-detail"><dt>Revision</dt><dd title={props.clientRevision}>{props.clientRevision.slice(0, 12)}</dd><dt>Connection</dt><dd>{props.offline ? <><span>{props.offline}</span><button type="button" onClick={props.onReconnect}>Reconnect</button></> : props.syncing ? "Syncing" : "Connected"}</dd></dl></Card>
      {props.ownerErrors.length > 0 && <Card title="Owner errors"><ul className="machine-errors">{props.ownerErrors.map((error) => <li key={error.id}><span><strong>{error.owner}</strong>{error.message}</span><button type="button" onClick={() => props.onDismissOwnerError(error.id)}>Dismiss</button></li>)}</ul></Card>}
    </div>
  </main>;
}
