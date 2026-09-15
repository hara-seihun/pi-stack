import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { API } from "../../server/api";
import { BASH_TIMEOUT_OPTIONS } from "../../server/protocol";
import { api } from "./client";
import { DismissibleError } from "./dismissible-error";
import { ChildThreadList } from "./thread-views";
import type { Session, ThreadSettings } from "./types";

function settingLabel(value: string) {
  if (value === "xhigh") return "Extra high";
  return value ? value[0].toUpperCase() + value.slice(1).replaceAll("_", " ") : "";
}
function bashTimeoutLabel(seconds: number) {
  return seconds === 60 ? "60 seconds" : seconds === 300 ? "5 minutes" : "Half an hour";
}
type UpdateSettings = (field: string, body: Record<string, string | number>) => void;

export function SettingsFields({ session, settings, saving, onUpdate }: { session: Session; settings: ThreadSettings; saving: string; onUpdate: UpdateSettings }) {
  const disabled = Boolean(saving || session.archivedAt);
  return <>
    {session.archivedAt && <p className="setting-unavailable">Restore this thread to change its settings.</p>}
    <section className="setting-card">
      <div className="setting-heading"><div><h3>Model</h3><p>Used for the next execution. Changing it does not interrupt current work.</p></div>{saving === "model" && <span className="setting-saving">Saving</span>}</div>
      <div className="setting-select"><select aria-label="Model" value={`${settings.model?.provider}\0${settings.model?.id}`} disabled={disabled} onChange={event => { const [modelProvider, modelId] = event.target.value.split("\0"); onUpdate("model", { modelProvider, modelId }); }}>{settings.models.map(model => <option key={`${model.provider}:${model.id}`} value={`${model.provider}\0${model.id}`}>{model.name || model.id} · {model.provider}</option>)}</select><span aria-hidden="true">⌄</span></div>
    </section>
    <section className="setting-card">
      <div className="setting-heading"><div><h3>Thinking</h3><p>How much reasoning the model can use</p></div>{saving === "thinking" && <span className="setting-saving">Saving</span>}</div>
      <div className="setting-options thinking-options" role="radiogroup" aria-label="Thinking level">{settings.thinkingLevels.map(level => <button key={level} type="button" role="radio" aria-checked={settings.thinkingLevel === level} className={settings.thinkingLevel === level ? "selected" : ""} disabled={disabled} onClick={() => onUpdate("thinking", { thinkingLevel: level })}>{settingLabel(level)}</button>)}</div>
    </section>
    <section className="setting-card">
      <div className="setting-heading"><div><h3>Speed</h3><p>Request scheduling priority</p></div>{saving === "speed" && <span className="setting-saving">Saving</span>}</div>
      {settings.speedModes.length ? <div className="setting-options speed-options" role="radiogroup" aria-label="Speed mode">{settings.speedModes.map(mode => <button key={mode} type="button" role="radio" aria-checked={settings.speedMode === mode} className={settings.speedMode === mode ? "selected" : ""} disabled={disabled} onClick={() => onUpdate("speed", { speedMode: mode })}>{settingLabel(mode)}</button>)}</div> : <p className="setting-unavailable">This model does not offer speed controls.</p>}
    </section>
    <section className="setting-card">
      <div className="setting-heading"><div><h3>Bash timeout</h3><p>Maximum time each bash command may run</p></div>{saving === "bash-timeout" && <span className="setting-saving">Saving</span>}</div>
      <div className="setting-select"><select aria-label="Bash timeout" value={settings.bashTimeoutSeconds} disabled={disabled} onChange={event => onUpdate("bash-timeout", { bashTimeoutSeconds: Number(event.target.value) })}>{BASH_TIMEOUT_OPTIONS.map(seconds => <option key={seconds} value={seconds}>{bashTimeoutLabel(seconds)}</option>)}</select><span aria-hidden="true">⌄</span></div>
    </section>
  </>;
}

export function SettingsPanel({ session, sessions, open, onClose, onOpenThread }: { session: Session; sessions: Session[]; open: boolean; onClose(): void; onOpenThread(session: Session): void }) {
  const childrenVersion = sessions.filter(child => child.parentId === session.id).map(child => `${child.id}:${child.revision}`).join(",");
  const [settings, setSettings] = useState<ThreadSettings | null>(null);
  const [children, setChildren] = useState<Session[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [childrenFailure, setChildrenFailure] = useState("");
  const [saving, setSaving] = useState("");
  const [loadFailure, setLoadFailure] = useState("");
  const [saveFailure, setSaveFailure] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!open || saving) return;
    let active = true;
    setLoadFailure("");
    api(API.sessionSettings.method, API.sessionSettings.path({ sessionId: session.id }))
      .then(result => { if (active) setSettings(result.settings); })
      .catch(error => { if (active) setLoadFailure(error?.message || String(error)); });
    return () => { active = false; };
  }, [open, session.id, session.revision, saving, attempt]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setChildrenLoading(true);
    setChildrenFailure("");
    api(API.sessionChildren.method, API.sessionChildren.path({ sessionId: session.id }))
      .then(result => { if (active) setChildren(result.children ?? []); })
      .catch(error => { if (active) setChildrenFailure(error?.message || String(error)); })
      .finally(() => { if (active) setChildrenLoading(false); });
    return () => { active = false; };
  }, [open, session.id, childrenVersion, attempt]);
  const update = async (field: string, body: Record<string, string | number>) => {
    if (saving) return;
    setSaving(field);
    setSaveFailure("");
    try {
      const result = await api(API.updateSessionSettings.method, API.updateSessionSettings.path({ sessionId: session.id }), body);
      setSettings(result.settings);
    } catch (error) { setSaveFailure(error?.message || String(error)); }
    finally { setSaving(""); }
  };
  return <>
    <AnimatePresence>{open && <motion.div key="settings-scrim" className="scrim settings-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />}</AnimatePresence>
    <AnimatePresence>{open && <motion.aside key="settings-panel" className="settings" aria-label="Thread settings" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}>
      <header className="settings-header"><div className="settings-title"><span>Thread settings</span><h2 title={session.name}>{session.name || "Thread"}</h2></div><button type="button" className="settings-close" aria-label="Close thread settings" onClick={onClose}>×</button></header>
      <div className="settings-body">
        <ChildThreadList children={children} loading={childrenLoading} error={childrenFailure} onOpen={onOpenThread} />
        <DismissibleError className="setting-unavailable" message={loadFailure} resetKey={attempt} />
        {(loadFailure || childrenFailure) && <button type="button" disabled={Boolean(saving)} onClick={() => retry(value => value + 1)}>Retry loading settings</button>}
        <DismissibleError className="setting-unavailable" message={saveFailure} />
        {settings ? <SettingsFields session={session} settings={settings} saving={saving} onUpdate={(field, body) => void update(field, body)} />
          : !loadFailure && <div className="settings-loading" aria-label="Loading thread settings"><span /><span /><span /></div>}
      </div>
    </motion.aside>}</AnimatePresence>
  </>;
}
