export const MODEL_GROUPS = [
  { id: "god", title: "God intelligence", description: "Super expensive" },
  { id: "smart", title: "Smart models", description: "" },
  { id: "fast", title: "Cheap and fast", description: "" },
  { id: "other", title: "Other models", description: "" },
] as const;

type ModelGroupId = (typeof MODEL_GROUPS)[number]["id"];

export function modelGroup(id: string, label: string): ModelGroupId {
  const identity = `${id} ${label}`.toLocaleLowerCase();
  if (/\b(fable|astra)\b/.test(identity)) return "god";
  if (/\b(opus|sol)\b/.test(identity)) return "smart";
  if (/\b(luna|bonsai)\b/.test(identity)) return "fast";
  return "other";
}

export function groupedModels<T>(models: readonly T[], identity: (model: T) => { id: string; label: string }) {
  return MODEL_GROUPS.map(group => ({
    ...group,
    models: models.filter(model => {
      const { id, label } = identity(model);
      return modelGroup(id, label) === group.id;
    }),
  })).filter(group => group.models.length > 0);
}

export function modelDisplayIcon(id: string, label: string, icon: string) {
  return modelGroup(id, label) === "fast" && /\bluna\b/i.test(`${id} ${label}`) ? "🌙" : icon;
}
