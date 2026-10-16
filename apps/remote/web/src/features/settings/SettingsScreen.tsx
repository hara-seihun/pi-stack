import { useEffect, useRef, useState, type ReactNode } from "react";
import { API } from "../../../../server/api";
import { parseTimezone, type PersonTimezone, type SettingEntry, type SettingsSnapshot } from "../../../../shared/settings";
import { api } from "../../client";
import { EnvironmentControl } from "../../EnvironmentControl";
import { NotificationControl } from "../../notification-control";
import { PermissionsSetup } from "../../permissions-setup";
import { nativePlatform, remote } from "../../native";
import { SettingsFields } from "../../thread-settings";
import type { useAppUpdate } from "../../app-update";
import type { Session, ThreadSettings } from "../../types";
import { CalendarSettings } from "./CalendarSettings";
import { SpeechSettings } from "./SpeechSettings";
import { parseSettingsEntry, parseSettingsSnapshot } from "../../../../shared/settings-wire";
import { assertNever } from "../../../../shared/explicit-state";
import "./settings.css";

export type AppUpdateState = ReturnType<typeof useAppUpdate>;
export { observeClientTimezone } from "./client-timezone";

type Resource<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };
const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="settings-section"><header><h2>{title}</h2>{description && <p>{description}</p>}</header><div className="settings-section-body">{children}</div></section>;
}

function Owner({ entry }: { entry: SettingEntry }) {
  const { owner, activation } = entry.definition;
  return <details className="settings-owner" open={entry.value.state === "unavailable"}><summary>Managed by {owner.component}</summary><dl>
    <div><dt>Location</dt><dd><code>{owner.location}</code></dd></div>
    <div><dt>Activation</dt><dd>{activation}</dd></div>
    {owner.command !== null && <div><dt>Command</dt><dd><code>{owner.command}</code></dd></div>}
  </dl></details>;
}

function timezoneValue(entry: SettingEntry): PersonTimezone | null {
  if (entry.value.state !== "set") return null;
  const value = entry.value.value;
  if (typeof value !== "object" || value === null || !("observedAt" in value) || typeof value.observedAt !== "string") return null;
  const parsed = parseTimezone(value, value.observedAt);
  return parsed.ok ? parsed.value : null;
}

function TimezoneField({ entry, busy, save }: { entry: SettingEntry; busy: boolean; save(value: unknown): void }) {
  const saved = timezoneValue(entry);
  const [zone, setZone] = useState(saved?.zone ?? "");
  const [invalid, setInvalid] = useState("");
  useEffect(() => { setZone(saved?.zone ?? ""); setInvalid(""); }, [saved?.zone, saved?.source]);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const submit = () => {
    const value = zone.trim();
    if (!value) { setInvalid("Enter a timezone."); return; }
    const parsed = parseTimezone({ zone: value, source: "configured" }, new Date().toISOString());
    if (!parsed.ok) { setInvalid(parsed.error.message); return; }
    setInvalid(""); save({ zone: parsed.value.zone, source: "configured" });
  };
  return <>
    {saved && <p className="settings-value">{saved.zone} · {saved.source === "configured" ? "Configured" : "Observed from your device"}</p>}
    {entry.value.state === "set" && !saved && <p role="alert">The server returned an invalid timezone value.</p>}
    <div className="settings-timezone"><input aria-label={entry.definition.label} list="settings-timezones" value={zone} disabled={busy || !entry.editable || entry.value.state === "unavailable"} placeholder="IANA timezone" onChange={event => { setZone(event.target.value); setInvalid(""); }} />
      <datalist id="settings-timezones"><option value="UTC" />{zones.map(value => <option key={value} value={value} />)}</datalist>
      <button type="button" disabled={busy || !entry.editable || entry.value.state === "unavailable" || !zone.trim()} onClick={submit}>{busy ? "Saving…" : "Use this timezone"}</button>
    </div>
    <p className="settings-detail">An explicit choice takes precedence over device observations.</p>
    {saved && <><p className="settings-detail">Recorded {new Date(saved.observedAt).toLocaleString()}</p><button type="button" disabled={busy || !entry.editable} onClick={() => save(null)}>Clear timezone</button></>}
    {invalid && <p role="alert">{invalid}</p>}
  </>;
}

function RegistryField({ entry, onSaved }: { entry: SettingEntry; onSaved(entry: SettingEntry): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async (value: unknown) => {
    if (running.current || !entry.editable) return;
    running.current = true; setBusy(true); setError("");
    try {
      const result = await api(API.updateSetting.method, API.updateSetting.path({ id: entry.definition.id }), { value });
      if (!mounted.current) return;
      const parsed = parseSettingsEntry(result.entry);
      if (!parsed.ok) { setError(parsed.error); return; }
      if (parsed.value.definition.id !== entry.definition.id) { setError("The server returned a different setting. Reload Settings before making another change."); return; }
      onSaved(parsed.value);
    } catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const value = entry.value;
  const control = () => {
    switch (entry.definition.kind) {
      case "timezone": return <TimezoneField entry={entry} busy={busy} save={value => void save(value)} />;
      case "boolean": {
        if (value.state === "unavailable") return null;
        if (value.state === "set") {
          if (typeof value.value !== "boolean") return <p role="alert">The server returned an invalid boolean value.</p>;
          return <label className="settings-toggle"><input type="checkbox" checked={value.value} disabled={busy || !entry.editable} onChange={event => void save(event.target.checked)} />{value.value ? "Enabled" : "Disabled"}{busy && <span role="status">Saving…</span>}</label>;
        }
        return entry.editable ? <div className="settings-unset-actions"><button disabled={busy} type="button" onClick={() => void save(true)}>Enable</button><button disabled={busy} type="button" onClick={() => void save(false)}>Disable</button></div> : null;
      }
      case "owner": return value.state === "set" ? <p className="settings-value">{typeof value.value === "string" || typeof value.value === "number" ? String(value.value) : typeof value.value === "boolean" ? value.value ? "Enabled" : "Disabled" : "Configured by owner"}</p> : null;
    }
    return assertNever(entry.definition.kind, "Settings field");
  };
  return <article className="settings-registry-entry"><h3>{entry.definition.label}</h3><p className="settings-detail">{entry.definition.description}</p>
    {value.state === "unset" && <p className="settings-value">Not set</p>}
    {value.state === "unavailable" && <p className="settings-value">Unavailable · {value.message}</p>}
    {control()}{error && <p role="alert">{error}</p>}<Owner entry={entry} />
  </article>;
}

function ThreadSettingsEditor({ session, onOpenThread }: { session: Session; onOpenThread(id: string): void }) {
  const [resource, setResource] = useState<Resource<ThreadSettings>>({ state: "loading" });
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => {
    if (running.current) return;
    const current = ++request.current;
    void api(API.sessionSettings.method, API.sessionSettings.path({ sessionId: session.id }))
      .then(result => { if (mounted.current && current === request.current) setResource({ state: "ready", value: result.settings }); })
      .catch(failure => { if (mounted.current && current === request.current) setResource({ state: "error", message: message(failure) }); });
  }, [session.id, session.revision, attempt]);
  const update = async (field: string, body: Record<string, string | number>) => {
    if (running.current || resource.state !== "ready") return;
    running.current = true;
    const current = ++request.current;
    setSaving(field); setError("");
    try {
      const result = await api(API.updateSessionSettings.method, API.updateSessionSettings.path({ sessionId: session.id }), body);
      if (mounted.current && current === request.current) setResource({ state: "ready", value: result.settings });
    } catch (failure) { if (mounted.current && current === request.current) setError(message(failure)); }
    finally { running.current = false; if (mounted.current && current === request.current) setSaving(""); }
  };
  return <div className="settings-thread-editor">
    <button className="settings-open-thread" type="button" onClick={() => onOpenThread(session.id)}>Open {session.name || session.id}</button>
    {resource.state === "loading" && <p role="status">Loading thread settings…</p>}
    {resource.state === "error" && <div><p role="alert">{resource.message}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
    {resource.state === "ready" && <SettingsFields session={session} settings={resource.value} saving={saving} onUpdate={(field, body) => void update(field, body)} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export interface SettingsScreenProps {
  sessions: Session[];
  update: AppUpdateState;
  autoCollapse: boolean;
  onAutoCollapseChange(enabled: boolean): void;
  onOpenThread(id: string): void;
  initialThreadId?: string | null;
}

export function SettingsScreen({ sessions, update, autoCollapse, onAutoCollapseChange, onOpenThread, initialThreadId }: SettingsScreenProps) {
  const [resource, setResource] = useState<Resource<SettingsSnapshot>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [identity, setIdentity] = useState(() => ({ user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() }));
  const identityRef = useRef(identity);
  const [threadId, setThreadId] = useState(initialThreadId ?? "");
  useEffect(() => { if (initialThreadId) setThreadId(initialThreadId); }, [initialThreadId]);
  useEffect(() => {
    const refresh = () => {
      const next = { user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() };
      if (next.user === identityRef.current.user && next.session === identityRef.current.session) return;
      identityRef.current = next;
      setIdentity(next); setThreadId("");
    };
    const changed = () => setAttempt(value => value + 1);
    window.addEventListener("pi-auth", refresh); window.addEventListener("pi-person", refresh); window.addEventListener("pi-settings-changed", changed);
    return () => { window.removeEventListener("pi-auth", refresh); window.removeEventListener("pi-person", refresh); window.removeEventListener("pi-settings-changed", changed); };
  }, []);
  useEffect(() => {
    let active = true;
    setResource({ state: "loading" });
    void api(API.settings.method, API.settings.path())
      .then(value => {
        if (!active) return;
        const parsed = parseSettingsSnapshot(value);
        setResource(parsed.ok ? { state: "ready", value: parsed.value } : { state: "error", message: parsed.error });
      })
      .catch(failure => { if (active) setResource({ state: "error", message: message(failure) }); });
    return () => { active = false; };
  }, [identity, attempt]);
  const saved = (entry: SettingEntry) => setResource(previous => previous.state === "ready" ? { state: "ready", value: { ...previous.value, entries: previous.value.entries.map(candidate => candidate.definition.id === entry.definition.id ? entry : candidate) } } : previous);
  const entries = resource.state === "ready" ? resource.value.entries : [];
  const sections = new Set(["person.autoCollapse", "person.threads", "device.phone", "device.notifications", "device.updates", "person.connection", "person.calendar", "device.speech"]);
  const personal = entries.filter(entry => entry.definition.scope === "person" && !sections.has(entry.definition.id));
  const sectionOwner = (id: string) => {
    const entry = entries.find(entry => entry.definition.id === id);
    return entry ? <div>{entry.value.state === "unavailable" && <p className="settings-detail">{entry.value.message}</p>}<Owner entry={entry} /></div> : null;
  };
  const timezone = entries.find(entry => entry.definition.id === "person.timezone");
  const timezoneRecord = timezone ? timezoneValue(timezone) : null;
  const autoCollapseEntry = entries.find(entry => entry.definition.id === "person.autoCollapse");
  const administrator = resource.state === "ready" && resource.value.administrator === true;
  const selected = sessions.find(session => session.id === threadId);
  const CollapseRow = autoCollapseEntry?.value.state === "set" ? "label" : "div";
  const scopeKey = `${identity.user}:${identity.session}`;
  return <main className="settings-screen" aria-labelledby="settings-title"><div className="settings-content">
    <header className="settings-page-heading"><h1 id="settings-title">Settings</h1><p>Personal preferences, this device and your threads.</p></header>
    {resource.state === "loading" && <p role="status">Loading settings…</p>}
    {resource.state === "error" && <div className="settings-load-error"><p role="alert">{resource.message}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry settings</button></div>}
    <Section title="Personal"><div className="settings-registry">{personal.map(entry => <RegistryField key={`${scopeKey}:${entry.definition.id}`} entry={entry} onSaved={saved} />)}</div>
      <CollapseRow className="settings-switch-row"><span><strong>{autoCollapseEntry?.definition.label ?? "Auto-collapse work and thoughts"}</strong><span className="settings-switch-detail">{autoCollapseEntry?.definition.description}</span>{autoCollapseEntry?.value.state === "unset" && <span className="settings-switch-detail">Not set</span>}{autoCollapseEntry?.value.state === "unavailable" && <span className="settings-switch-detail">{autoCollapseEntry.value.message}</span>}</span>
        {autoCollapseEntry?.value.state === "set" && <input type="checkbox" aria-label="Auto-collapse work and thoughts" checked={autoCollapse} disabled={!autoCollapseEntry.editable} onChange={event => onAutoCollapseChange(event.target.checked)} />}
      </CollapseRow>
      {autoCollapseEntry?.value.state === "unset" && autoCollapseEntry.editable && <div className="settings-unset-actions"><button type="button" onClick={() => onAutoCollapseChange(true)}>Enable automatic collapse</button><button type="button" onClick={() => onAutoCollapseChange(false)}>Disable automatic collapse</button></div>}
      {autoCollapseEntry && <Owner entry={autoCollapseEntry} />}
    </Section>
    <Section title="Speech preferences"><SpeechSettings key={scopeKey} />{sectionOwner("device.speech")}</Section>
    <Section title="Notifications" description="Permission belongs to this device or browser, not to your other devices."><NotificationControl />{sectionOwner("device.notifications")}</Section>
    <Section title="Phone control">{nativePlatform ? <PermissionsSetup key={scopeKey} /> : <p>Phone control preferences and permissions are available in the Android app on that phone.</p>}{sectionOwner("device.phone")}</Section>
    <Section title="Calendar subscriptions"><CalendarSettings key={scopeKey} refreshVersion={timezoneRecord ? `${timezoneRecord.zone}:${timezoneRecord.observedAt}` : "unset"} />{sectionOwner("person.calendar")}</Section>
    <Section title="Thread settings" description="Choose a real thread to change its model, thinking, speed and command timeout.">
      <label className="settings-field-label" htmlFor="settings-thread">Thread</label><select id="settings-thread" value={selected ? threadId : ""} onChange={event => setThreadId(event.target.value)}><option value="">Choose a thread</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.name || session.id}{session.archivedAt ? " · Closed" : ""}</option>)}</select>
      {!sessions.length && <p>No threads are available in this environment.</p>}
      {selected && <ThreadSettingsEditor key={`${scopeKey}:${selected.id}`} session={selected} onOpenThread={onOpenThread} />}
      {sectionOwner("person.threads")}
    </Section>
    <Section title="App update"><p className="settings-value">Web revision <code>{__PI_REMOTE_REVISION__}</code></p>
      {nativePlatform ? remote.checkAppUpdate && remote.installAppUpdate ? <><button type="button" disabled={update.busy} onClick={update.onClick}>{update.busy ? "Updating…" : update.approval || update.error ? "Update" : "Check for updates"}</button>{update.status && <p role="status">{update.status}</p>}{update.error && <p role="alert">{update.error}</p>}</> : <p>App updates are unavailable in this Android shell.</p> : <p className="settings-detail">The browser loads the current web app when you reload.</p>}
      {sectionOwner("device.updates")}
    </Section>
    <Section title="Environment and account"><EnvironmentControl /><dl className="settings-account"><div><dt>Account</dt><dd>{identity.user || "No person selected"}</dd></div><div><dt>Session</dt><dd>{identity.session ? "Signed in · folder unlocked" : "Not signed in or folder locked"}</dd></div></dl>{sectionOwner("person.connection")}</Section>
    {administrator && <Section title="Administration" description="System-wide settings. Changes can affect everyone using this machine."><div className="settings-registry">{entries.filter(entry => entry.definition.scope === "system").map(entry => <RegistryField key={`${scopeKey}:${entry.definition.id}`} entry={entry} onSaved={saved} />)}</div></Section>}
  </div></main>;
}
