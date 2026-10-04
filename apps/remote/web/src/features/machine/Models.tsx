import { useRef, useState } from "react";
import { API } from "../../../../server/api";
import type { ModelAvailability, SetModelAvailabilityRequest, SetModelAvailabilityResponse } from "../../../../server/protocol";
import { api } from "../../client";
import { DismissibleError } from "../../dismissible-error";

export async function setModelAvailability(id: string, enabled: boolean): Promise<{ ok: true; value: SetModelAvailabilityResponse } | { ok: false; error: string }> {
  const body: SetModelAvailabilityRequest = { enabled };
  try {
    return { ok: true, value: await api(API.setModelAvailability.method, API.setModelAvailability.path({ id }), body) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type ModelChange = { pending: boolean; error: string };

export function ModelAvailabilityControls({ models, canManage = false, changes, onSet }: {
  models: ModelAvailability[];
  canManage?: boolean;
  changes: Record<string, ModelChange>;
  onSet(id: string, enabled: boolean): void;
}) {
  return <>
    <p className="machine-secondary">Applies to everyone on this machine. Existing threads are unchanged.</p>
    {!canManage && <p className="machine-secondary">Only the administrator can change model availability.</p>}
    <div className="machine-actions machine-models">
      {models.map(model => {
        const change = changes[model.id];
        return <div key={model.id}>
          <button className="machine-action" type="button" role="switch" aria-label={`${model.label} for everyone's new threads`} aria-checked={model.enabled} aria-busy={change?.pending || undefined} disabled={!canManage || change?.pending} onClick={() => { if (canManage && !change?.pending) onSet(model.id, !model.enabled); }}>
            <span>{model.label}</span><strong>{model.enabled ? "Enabled" : "Disabled"}{change?.pending && " · Saving…"}</strong>
          </button>
          <DismissibleError message={change?.error} dismissLabel={`Dismiss ${model.label} availability error`} />
        </div>;
      })}
    </div>
    {models.length === 0 && <p className="machine-secondary">No models are configured.</p>}
  </>;
}

export function Models({ models, canManage = false }: { models: ModelAvailability[]; canManage?: boolean }) {
  const [changes, setChanges] = useState<Record<string, ModelChange>>({});
  const pending = useRef(new Set<string>());
  const setEnabled = async (id: string, enabled: boolean) => {
    if (!canManage || pending.current.has(id)) return;
    pending.current.add(id);
    setChanges(current => ({ ...current, [id]: { pending: true, error: "" } }));
    const result = await setModelAvailability(id, enabled);
    pending.current.delete(id);
    setChanges(current => ({ ...current, [id]: { pending: false, error: result.ok ? "" : result.error } }));
  };
  return <ModelAvailabilityControls models={models} canManage={canManage} changes={changes} onSet={(id, enabled) => void setEnabled(id, enabled)} />;
}
