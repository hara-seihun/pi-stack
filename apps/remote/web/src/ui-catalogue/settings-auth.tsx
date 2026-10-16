import { useEffect, useState, type ReactNode } from "react";
import type { UiCase } from "./contract";
import { configureFixtureTransport, type FixtureRoute } from "./transport";
import { SettingsScreen, type AppUpdateState } from "../features/settings/SettingsScreen";
import { EnvironmentControl } from "../EnvironmentControl";
import { PermissionsSetup } from "../permissions-setup";
import { SignInDialog } from "../SignInDialog";
import { UnlockDialog } from "../UnlockDialog";
import { NetworkJoinPrompt } from "../network-join";
import { AppUpdateStatus } from "../app-update";
import { auth } from "../person";
import { ensureUnlocked, registerAuthenticationBootstrap } from "../client";
import { SETTINGS, type SettingEntry, type SettingsSnapshot } from "../../../shared/settings";
import type { Session, ThreadSettings } from "../../../server/protocol";
import { appStorageKey } from "../app-path";
import "../features/settings/settings.css";

const pending = (): Promise<Response> => new Promise(() => {});
const failure = (message: string) => Response.json({ error: message }, { status: 503 });
const person = { user: "ui-fixture", displayName: "Synthetic reviewer", requiresUnlock: true };
const endpoints = [{ id: "synthetic", name: "Synthetic local environment", baseUrl: "" }, { id: "synthetic-long", name: "Synthetic secondary environment with a deliberately long but finite name", baseUrl: "/synthetic-secondary" }];
const commonRoutes = (): FixtureRoute[] => [
  { method: "POST", path: "/v1/diagnostics/requests", reply: () => Response.json({ ok: true }) },
  { method: "GET", path: "/v1/environment", reply: () => Response.json({ environment: { persons: [person], custody: null } }) },
  { method: "GET", path: "/v1/auth/session", reply: () => Response.json({ ok: true, user: person.user, session: "synthetic-ui-session" }) },
  { method: "GET", path: "/v1/environments", reply: () => Response.json({ environments: endpoints }) },
  { method: "GET", path: "/v1/health", reply: () => Response.json({ environmentId: "synthetic" }) },
];
const updateIdle: AppUpdateState = { visible: false, busy: false, status: "", error: "", approval: false, onClick: () => undefined };
const updateApproval: AppUpdateState = { visible: true, busy: false, status: "Finish the update in Android. Tap Update to reopen installation.", error: "", approval: true, onClick: () => undefined };
const updateApplying: AppUpdateState = { visible: true, busy: true, status: "Applying update…", error: "", approval: false, onClick: () => undefined };
const updateMedia: AppUpdateState = { visible: true, busy: false, status: "Update waits until the meeting or voice call ends.", error: "", approval: false, onClick: () => undefined };
const updateError: AppUpdateState = { visible: true, busy: false, status: "Update needs retry. Tap Update to retry.", error: "The verified update could not be downloaded. The installed app is unchanged. Retry when this synthetic connection returns.", approval: false, onClick: () => undefined };
const session: Session = { id: "synthetic-thread", name: "Synthetic thread with a long name to inspect model and execution settings", parentId: null, hasChildren: false, origin: "person", model: "synthetic-model", cwd: "/synthetic", workspaceName: "Synthetic", environment: "synthetic", state: "idle", lifecycle: { kind: "idle" }, held: false, activity: "idle", activeTools: [], provider: "synthetic", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null };
const threadSettings: ThreadSettings = { models: [{ id: "synthetic-model", name: "Synthetic model", provider: "synthetic", thinkingLevels: ["low", "high"], speedModes: ["standard", "priority"] }], model: { id: "synthetic-model", provider: "synthetic" }, thinkingLevels: ["low", "high"], thinkingLevel: "high", speedModes: ["standard", "priority"], speedMode: "standard", bashTimeoutSeconds: 60 };
type SettingsVariant = "set" | "unset" | "unavailable" | "loading" | "error" | "administrator" | "long" | "thread";
function snapshot(variant: SettingsVariant): SettingsSnapshot {
  const entries: SettingEntry[] = SETTINGS.filter(definition => variant === "administrator" || definition.scope === "person").map(definition => ({
    definition: variant === "long" ? { ...definition, owner: { ...definition.owner, location: `${definition.owner.location}/a-deliberately-long-unbroken-synthetic-owner-coordinate-to-check-overflow-and-wrapping` } } : definition,
    value: variant === "unavailable" ? { state: "unavailable", message: "Synthetic owning service is disconnected; no value has been guessed." } : variant === "unset" ? { state: "unset" } : definition.id === "person.timezone" ? { state: "set", value: { zone: "Asia/Seoul", source: "configured", observedAt: "2026-10-09T00:00:00Z" } } : definition.kind === "boolean" ? { state: "set", value: true } : { state: "set", value: "Managed by the declared synthetic owner" },
    editable: definition.kind !== "owner" && variant !== "unavailable",
  }));
  return { administrator: variant === "administrator", entries };
}
function SettingsFixture({ variant, nativeUpdate }: { variant: SettingsVariant; nativeUpdate?: AppUpdateState }) {
  const [collapse, setCollapse] = useState(true);
  return <SettingsScreen sessions={variant === "thread" ? [session] : []} initialThreadId={variant === "thread" ? session.id : null} update={nativeUpdate ?? updateIdle} autoCollapse={collapse} onAutoCollapseChange={setCollapse} onOpenThread={() => undefined} />;
}
function settings(variant: SettingsVariant, nativeUpdate?: AppUpdateState) {
  configureFixtureTransport([...commonRoutes(),
    { method: "GET", path: "/v1/settings", reply: () => variant === "loading" ? pending() : variant === "error" ? failure("Synthetic settings service is disconnected. Retry to load the current values.") : Response.json(snapshot(variant)) },
    { method: "GET", path: "/v1/sessions/synthetic-thread/settings", reply: () => Response.json({ settings: threadSettings }) },
  ]);
  return <SettingsFixture variant={variant} nativeUpdate={nativeUpdate} />;
}
function Surface({ children }: { children: ReactNode }) { return <section className="settings-section" style={{ maxWidth: 860, margin: "24px auto", width: "calc(100% - 24px)" }}><div className="settings-section-body">{children}</div></section>; }
function environment(variant: "ready" | "loading" | "error" | "locked" | "account") {
  const routes = commonRoutes();
  if (variant === "loading" || variant === "error") {
    routes.unshift({ method: "GET", path: "/v1/environments", reply: () => variant === "loading" ? pending() : failure("Synthetic discovery unavailable: no environment was selected.") });
    if (variant === "error") routes.unshift({ method: "GET", path: "/v1/environment", reply: () => failure("Synthetic person chooser unavailable.") });
  }
  configureFixtureTransport(routes);
  if (variant === "account") auth.authentication = { type: "oidc", label: "Sign in with synthetic account", loginPath: "/v1/auth/login" };
  if (variant === "locked") auth.clear();
  return <Surface><EnvironmentControl /></Surface>;
}
function TriggerAuth({ kind }: { kind: "sign-in" | "sign-in-error" | "unlock" | "custody" | "unlock-error" }) {
  useEffect(() => {
    registerAuthenticationBootstrap({ accountSignIn: () => kind.startsWith("sign-in"), prepare: async () => {
      if (kind === "sign-in-error") throw new Error("The synthetic sign-in session expired while the router was restarting. Retry your session or sign in again.");
    } });
    void ensureUnlocked().catch(() => undefined);
  }, [kind]);
  return null;
}
function authentication(kind: "sign-in" | "sign-in-error" | "unlock" | "custody" | "unlock-error") {
  const routes = commonRoutes();
  if (kind === "custody") routes.unshift({ method: "GET", path: "/v1/environment", reply: () => Response.json({ environment: { persons: [person], custody: { locked: true, message: "Synthetic folder custody is waiting for the machine to finish unlocking after restart." } } }) });
  if (kind === "unlock-error") {
    let chooserReads = 0;
    routes.unshift({ method: "GET", path: "/v1/environment", reply: () => chooserReads++ === 0 ? Response.json({ environment: { persons: [person], custody: null } }) : failure("Synthetic person chooser cannot be reached.") });
  }
  configureFixtureTransport(routes);
  auth.authentication = kind.startsWith("sign-in") ? { type: "oidc", label: "Sign in with synthetic account", loginPath: "/v1/auth/login" } : null;
  auth.clear();
  return <><SignInDialog /><UnlockDialog /><TriggerAuth kind={kind} /></>;
}
function ExpandedNetwork({ expand }: { expand: boolean }) {
  useEffect(() => {
    if (!expand) return;
    const observer = new MutationObserver(() => {
      const button = document.querySelector<HTMLButtonElement>(".network-join-summary button[aria-expanded='false']");
      if (button) { observer.disconnect(); button.click(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [expand]);
  return <NetworkJoinPrompt />;
}
function network(variant: "collapsed" | "expanded" | "long" | "connected" | "absent") {
  localStorage.removeItem(appStorageKey("network-join-snoozed-until"));
  configureFixtureTransport([{ method: "GET", path: "/v1/network", reply: () => Response.json(variant === "absent" ? { network: null } : { network: { id: "synthetic", name: variant === "long" ? "Synthetic household network with a deliberately long finite name" : "Synthetic network", loginServer: variant === "long" ? "https://synthetic-coordination-server-with-a-deliberately-long-name.invalid" : "https://synthetic.invalid" }, connected: variant === "connected" }) }]);
  return <ExpandedNetwork expand={variant === "expanded" || variant === "long"} />;
}
function item(id: string, title: string, component: string, contract: string, render: UiCase["render"], boundary: UiCase["boundary"] = "finite-variant"): UiCase { return { id, title, component, contract, boundary, render }; }
export const settingsAuthCases: UiCase[] = [
  ...(["set", "unset", "unavailable", "loading", "error", "administrator", "long", "thread"] as const).map(variant => item(`settings-${variant}`, `Settings · ${variant}`, "SettingsScreen", "Real settings registry and nested controls; each value explicitly set, unset or unavailable; synthetic transport only.", () => settings(variant), variant === "long" ? "content-boundary" : "composition")),
  item("settings-native-update-approval", "Native settings · installer approval", "SettingsScreen", "Android updater waits for installer approval.", () => settings("set", updateApproval), "composition"),
  item("settings-native-update-error", "Native settings · update error", "SettingsScreen", "Verified updater failed; installed app unchanged.", () => settings("set", updateError), "composition"),
  item("settings-native-updating", "Native settings · applying update", "SettingsScreen", "A verified web update is applying; additional update actions are disabled.", () => settings("set", updateApplying), "composition"),
  item("settings-native-update-media", "Native settings · meeting active", "SettingsScreen", "Updater explicitly waits for live media to end.", () => settings("set", updateMedia), "composition"),
  ...(["off", "reconnecting", "granted", "unavailable", "loading", "error", "service-error", "long"] as const).map(variant => item(`permissions-${variant}`, `Phone permissions · ${variant}`, "PermissionsSetup", "Synthetic Android bridge reports only explicit grant capability booleans; absent capability is unavailable, not granted.", () => { configureFixtureTransport(commonRoutes()); return <Surface><PermissionsSetup /></Surface>; }, variant === "long" ? "content-boundary" : "finite-variant")),
  ...(["ready", "loading", "error", "locked", "account"] as const).map(variant => item(`environment-${variant}`, `Environment · ${variant}`, "EnvironmentControl", "Real environment picker with explicit synthetic discovery, folder lock and account states.", () => environment(variant))),
  ...(["sign-in", "sign-in-error", "unlock", "custody", "unlock-error"] as const).map(kind => item(`auth-${kind}`, `Authentication · ${kind}`, kind.startsWith("sign-in") ? "SignInDialog" : "UnlockDialog", "Real modal triggered through the production authentication registration; synthetic identity only.", () => authentication(kind))),
  ...(["collapsed", "expanded", "long", "connected", "absent"] as const).map(variant => item(`network-${variant}`, `Private network · ${variant}`, "NetworkJoinPrompt", "Router-declared synthetic network; no join prompt for connected or absent network.", () => network(variant), variant === "long" ? "content-boundary" : "finite-variant")),
  item("network-android", "Private network · Android setup", "NetworkJoinPrompt", "Native Android setup instructions for the declared synthetic network.", () => network("expanded")),
  item("network-ios", "Private network · iOS setup", "NetworkJoinPrompt", "Synthetic iPhone platform selects iOS setup instructions for the declared network.", () => network("expanded")),
  item("update-approval", "Update · installer approval", "AppUpdateStatus", "Installer approval is a visible pending state.", () => <AppUpdateStatus update={updateApproval} />),
  item("update-error", "Update · retry error", "AppUpdateStatus", "Download failure provides a retry without implying installation.", () => <AppUpdateStatus update={updateError} />),
  item("update-idle", "Update · no notice", "AppUpdateStatus", "No error or approval produces no interrupting status surface.", () => <AppUpdateStatus update={updateIdle} />),
];
