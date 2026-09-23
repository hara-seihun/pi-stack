import { BASH_TIMEOUT_OPTIONS } from "../../server/protocol";
import { groupedModels, modelDisplayIcon } from "./model-groups";
import type { Session, ThreadSettings } from "./types";

function settingLabel(value: string) {
  if (value === "xhigh") return "Extra high";
  return value ? value[0].toUpperCase() + value.slice(1).replaceAll("_", " ") : "";
}
function bashTimeoutLabel(seconds: number) {
  return seconds === 60 ? "60 seconds" : seconds === 300 ? "5 minutes" : "Half an hour";
}
type UpdateSettings = (field: string, body: Record<string, string | number>) => void;
type ModelOption = ThreadSettings["models"][number] & { thinkingLevels?: string[] };

function defaultThinkingLevel(model: { provider: string; id: string }) {
  return model.provider === "openai-codex" && model.id === "gpt-6-luna" ? "max" : "high";
}

export function optimisticThreadSettings(settings: ThreadSettings, body: Record<string, string | number>): ThreadSettings {
  let next = settings;
  if (typeof body.modelProvider === "string" && typeof body.modelId === "string") {
    const model = settings.models.find(candidate => candidate.provider === body.modelProvider && candidate.id === body.modelId) as ModelOption | undefined;
    const selected = { provider: body.modelProvider, id: body.modelId };
    const thinkingLevel = defaultThinkingLevel(selected);
    next = {
      ...next,
      model: selected,
      thinkingLevels: model?.thinkingLevels?.length ? model.thinkingLevels : [thinkingLevel],
      thinkingLevel,
      speedModes: selected.provider === "openai-codex" ? ["standard", "priority"] : [],
      speedMode: "standard",
    };
  }
  if (typeof body.thinkingLevel === "string") next = { ...next, thinkingLevel: body.thinkingLevel };
  if (typeof body.speedMode === "string") next = { ...next, speedMode: body.speedMode };
  if (typeof body.bashTimeoutSeconds === "number") next = { ...next, bashTimeoutSeconds: body.bashTimeoutSeconds as ThreadSettings["bashTimeoutSeconds"] };
  return next;
}

export function SettingsFields({ session, settings, saving, onUpdate }: { session: Session; settings: ThreadSettings; saving: string; onUpdate: UpdateSettings }) {
  const disabled = Boolean(saving || session.archivedAt);
  const modelGroups = groupedModels(settings.models, model => ({ id: model.id, label: model.name || model.id }));
  return <>
    {session.archivedAt && <p className="setting-unavailable">Restore this thread to change its settings.</p>}
    <section className="setting-card">
      <div className="setting-heading"><div><h3>Model</h3><p>Used for the next execution. Changing it does not interrupt current work.</p></div>{saving === "model" && <span className="setting-saving">Saving</span>}</div>
      <div className="setting-select"><select aria-label="Model" value={`${settings.model?.provider}\0${settings.model?.id}`} disabled={disabled} onChange={event => { const [modelProvider, modelId] = event.target.value.split("\0"); onUpdate("model", { modelProvider, modelId }); }}>{modelGroups.map(group => <optgroup key={group.id} label={[group.title, group.description].filter(Boolean).join(" · ")}>{group.models.map(model => {
        const icon = modelDisplayIcon(model.id, model.name || model.id, "");
        return <option key={`${model.provider}:${model.id}`} value={`${model.provider}\0${model.id}`}>{icon && `${icon} `}{model.name || model.id} · {model.provider}</option>;
      })}</optgroup>)}</select><span aria-hidden="true">⌄</span></div>
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

