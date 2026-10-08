import { useState } from "react";
import type { Dashboard, FileBrowserEntry, PeopleUsagePeriodData, PlanAccountRow, PlanCard } from "../../../server/protocol";
import { FEATURES, type Feature, type FeatureUsageSummary, type UsageResult } from "../../../shared/feature-usage";
import { API } from "../../../server/api";
import { FilesScreen } from "../features/files/FilesScreen";
import { FeatureUsagePanel } from "../features/machine/FeatureUsage";
import { MachineScreen, type MachineScreenProps } from "../features/machine/MachineScreen";
import { configureFixtureTransport } from "./transport";
import type { UiCase } from "./contract";

const noop = () => {};
const longName = "Research-workspace-with-a-very-long-unbroken-name-".repeat(3);
const at = "2026-10-09T12:00:00Z";
const accounts: PlanAccountRow[] = [
  { accountId: "account-01", accountLabel: "Primary account", state: "ready", percentLeft: 72, usedPercent: 28, meterId: "weekly", windowHours: 168, readingAt: at, resetAt: "2026-10-12T00:00:00Z", bankedResets: 2, bankedResetsAt: at, bankedResetExpiresAt: "2026-10-31T00:00:00Z" },
  { accountId: longName, accountLabel: longName, state: "stale", percentLeft: 23, usedPercent: 77, meterId: "daily", windowHours: 5, readingAt: "2026-10-01T12:00:00Z", resetAt: null, bankedResets: 0, bankedResetsAt: at, bankedResetExpiresAt: null },
  { accountId: "account-unavailable", accountLabel: "Reading unavailable", state: "unavailable", percentLeft: null, usedPercent: null, meterId: null, windowHours: null, readingAt: null, resetAt: null, bankedResets: null, bankedResetsAt: null, bankedResetExpiresAt: null },
];
const plan: PlanCard = {
  id: "openai", label: "OpenAI", icon: "openai", state: "ready", text: "72%", description: "Shared subscription quota",
  spent: { day: 12.34, week: 83.45 },
  metrics: [72, 23, 0, 100].map((left, index) => ({ id: `quota-${index}`, model: `model-${index}`, modelLabel: ["Sol", "Luna", "Astra", "Fable"][index], text: `${left}% remaining`, cacheText: index === 0 ? "84%" : "", description: index === 0 ? "Weekly subscription quota" : "5-hour quota", accounts })),
};
const period: PeopleUsagePeriodData = {
  since: "2026-10-08T12:00:00Z", until: at, spend: 45.5, used: 36.7,
  subscriptions: [{ label: "OpenAI", accounts: 3, monthlyUsd: 200, spend: 20, used: 16 }, { label: "Anthropic", accounts: 2, monthlyUsd: 200, spend: 25.5, used: 20.7 }],
  people: [{ user: "example", name: "Example person", percent: 62, spend: 22.75, tokens: 12000000, value: 87.3, workersPercent: 45 }, { user: "second", name: "Second person", percent: 38, spend: 13.95, tokens: 2500000, value: 21.8, workersPercent: null }],
};
const dashboard: Dashboard = {
  plans: [plan, { ...plan, id: "anthropic", label: "Anthropic", icon: "anthropic", description: "Claude subscription usage", spent: { day: 6.5, week: 29.5 } }],
  actions: [], modelCounts: [],
  machine: { cpuPercent: 32, gpuPercent: 67, memory: { usedBytes: 18e9, totalBytes: 64e9, percentUsed: 28 }, disk: { usedBytes: 340e9, totalBytes: 1e12, availableBytes: 660e9, percentUsed: 34 } },
  people: { periods: { day: period, week: { ...period, spend: 318.5, used: 256.9 } } },
  allowance: { weeklyUsd: 200, usedUsd: 84.65, resetsAt: "2026-10-12T00:00:00Z" },
};
const emptySummary: FeatureUsageSummary = { since: Date.parse(at), asOf: Date.parse(at), retentionDays: 90, features: [] };
const manySummary: FeatureUsageSummary = {
  ...emptySummary,
  features: (Object.keys(FEATURES) as Feature[]).map((id, index) => ({ id, observations: [
    { actor: "human", uses: index * 31, lastUsedAt: index === 0 ? null : Date.parse(at), last7Days: index * 4, previous30Days: index * 22, state: index % 2 === 0 ? { value: "enabled", observedAt: Date.parse(at) } : null },
    { actor: "agent", uses: index * 89, lastUsedAt: Date.parse(at), last7Days: index * 11, previous30Days: index * 64, state: { value: "unavailable", observedAt: Date.parse(at) } },
  ] })),
};
type UsageFixture = { state: "ready"; summary: FeatureUsageSummary } | { state: "loading" } | { state: "error"; message: string };
function usageRoutes(fixture: UsageFixture) {
  configureFixtureTransport([{ method: "GET", path: API.featureUsage.path(), reply: () => {
    if (fixture.state === "loading") return new Promise<Response>(() => {});
    const result: UsageResult<FeatureUsageSummary> = fixture.state === "error" ? { ok: false, error: { code: "storage_unavailable", message: fixture.message } } : { ok: true, value: fixture.summary };
    return Response.json(result);
  } }]);
}
function machineCase(id: string, title: string, changes: Partial<MachineScreenProps>, usage: UsageFixture = { state: "ready", summary: emptySummary }): UiCase {
  return { id: `machine-${id}`, title, component: "MachineScreen / FeatureUsagePanel", contract: "Production machine dashboard: quota, spending, host, feature collection and connection state remain readable without live transports.", boundary: id.includes("many") || id.includes("long") ? "content-boundary" : "finite-variant", render() {
    usageRoutes(usage);
    return <MachineScreen dashboard={dashboard} modelCounts={new Map([["model-0", 12]])} ownerErrors={[]} offline="" syncing={false} onDismissOwnerError={noop} onReconnect={noop} features={<FeatureUsagePanel />} clientRevision="catalogue-synthetic-revision" {...changes} />;
  } };
}

type FileFixture = { state: "unset" } | { state: "loading"; path: string } | { state: "ready"; entry: FileBrowserEntry } | { state: "error"; path: string; message: string };
function FilesFixture({ fixture, many }: { fixture: FileFixture; many: boolean }) {
  const [selected, setSelected] = useState<string | null>(fixture.state === "unset" ? null : fixture.state === "ready" ? fixture.entry.path : fixture.path);
  const [attached, setAttached] = useState<string | null>(null);
  return <><FilesScreen layout="stack" selectedPath={selected} onSelect={setSelected} shortcuts={many ? Array.from({ length: 14 }, (_, index) => ({ label: index === 0 ? longName : `Workspace ${index + 1}`, path: `/synthetic/workspace-${index}` })) : [{ label: "Home", path: "/synthetic" }, { label: "Projects", path: "/synthetic/projects" }]} onAttach={setAttached} />{attached && <p role="status">Attached synthetic path: {attached}</p>}</>;
}
function fileCase(id: string, title: string, fixture: FileFixture, many = false): UiCase {
  return { id: `files-${id}`, title, component: "FilesScreen", contract: "Exact-path selection has explicit unset/loading/error/file/directory/other states; long paths and workspace lists must fit all viewport sizes.", boundary: many ? "content-boundary" : "finite-variant", render() {
    const path = fixture.state === "unset" ? null : fixture.state === "ready" ? fixture.entry.path : fixture.path;
    configureFixtureTransport(path === null ? [] : [{ method: "GET", path: API.fileInfo.path({}, { path }), reply: () => {
      if (fixture.state === "loading") return new Promise<Response>(() => {});
      if (fixture.state === "error") return Response.json({ error: fixture.message }, { status: 404 });
      if (fixture.state === "ready") return Response.json({ entry: fixture.entry });
      return Response.json({ error: "ui_fixture_unset_path" }, { status: 501 });
    } }]);
    return <FilesFixture fixture={fixture} many={many} />;
  } };
}

export const machineFilesCases: UiCase[] = [
  machineCase("populated", "Machine · populated subscriptions and host", {}),
  machineCase("unmeasured", "Machine · dashboard absent / host not measured", { dashboard: null }),
  machineCase("syncing", "Machine · syncing, null GPU and disk readings", { syncing: true, dashboard: { ...dashboard, plans: [], people: null, allowance: null, machine: { ...dashboard.machine!, gpuPercent: null, disk: null } } }),
  machineCase("offline-long-errors", "Machine · offline and long owner errors", { dashboard: { ...dashboard, plans: [], people: null, allowance: null }, offline: `Connection lost: ${longName}`, ownerErrors: Array.from({ length: 8 }, (_, index) => ({ id: String(index), owner: index === 0 ? longName : `Owner ${index + 1}`, message: index === 0 ? longName : "The synthetic task failed to reconnect. Retry the connection." })) }),
  machineCase("allowance-exhausted", "Machine · exhausted and zero spending limit", { dashboard: { ...dashboard, plans: [], people: null, allowance: { weeklyUsd: 0, usedUsd: 0, resetsAt: "2026-10-12T00:00:00Z" } } }),
  machineCase("quotas-unavailable", "Machine · unavailable account quota", { dashboard: { ...dashboard, plans: [{ ...plan, spent: null, metrics: [{ ...plan.metrics[0], text: "—", accounts }] }], people: null, allowance: null } }),
  machineCase("people-empty", "Machine · no recorded people usage", { dashboard: { ...dashboard, plans: [], allowance: null, people: { periods: { day: { ...period, subscriptions: [], people: [] }, week: { ...period, subscriptions: [], people: [] } } } } }),
  machineCase("people-many-long", "Machine · many people and long names", { dashboard: { ...dashboard, plans: [], allowance: null, people: { periods: { day: { ...period, people: Array.from({ length: 18 }, (_, index) => ({ ...period.people[0], user: `person-${index}`, name: index === 0 ? longName : `Synthetic person ${index + 1}`, percent: 100 / 18 })) }, week: period } } } }),
  machineCase("feature-loading", "Machine · feature usage loading", { dashboard: null }, { state: "loading" }),
  machineCase("feature-error", "Machine · feature collection unavailable", { dashboard: null }, { state: "error", message: `Feature storage unavailable: ${longName}` }),
  machineCase("feature-many", "Machine · complete feature collection", { dashboard: null }, { state: "ready", summary: manySummary }),
  fileCase("unset", "Files · no selected path", { state: "unset" }),
  fileCase("loading", "Files · inspecting exact path", { state: "loading", path: `/synthetic/${longName}/notes.md` }),
  fileCase("error", "Files · path inspection failed", { state: "error", path: "/synthetic/missing.md", message: `Cannot inspect path: ${longName}` }),
  fileCase("directory", "Files · directory selected", { state: "ready", entry: { name: "Projects", path: "/synthetic/projects", kind: "directory" } }),
  fileCase("file", "Files · attachment ready", { state: "ready", entry: { name: "notes.md", path: "/synthetic/notes.md", kind: "file" } }),
  fileCase("other", "Files · irregular path", { state: "ready", entry: { name: "socket", path: "/synthetic/socket", kind: "other" } }),
  fileCase("many-long", "Files · long path and many workspaces", { state: "ready", entry: { name: "long.md", path: `/synthetic/${longName}/${longName}.md`, kind: "file" } }, true),
];
