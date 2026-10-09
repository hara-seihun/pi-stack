import { API } from "../../server/api";
import { piFetch } from "./client";
import type { Feature, FeatureEvent, FeatureState } from "../../shared/feature-usage";
let collectionError: string | null = null;
let generation = 0;
const pending = new Set<AbortController>();
export function resetFeatureCollection(): void { generation++; collectionError = null; for (const controller of pending) controller.abort(); pending.clear(); }
export const featureCollectionError = () => collectionError;
export function observeArtifactActions(): () => void {
  const used = (event: Event) => {
    if (!event.isTrusted) return;
    const element = event.composedPath().find(item => item instanceof Element && (item.matches("a[href],img[src],audio[src],video[src]"))) as Element | undefined;
    const source = element?.getAttribute(element.matches("a") ? "href" : "src");
    if (!source) return;
    let path: string;
    try { path = new URL(source, window.location.href).pathname; } catch { return; }
    if (API.sessionFiles.match("GET", path) || API.fileDownload.match("GET", path)) recordFeatureUsage("artifact");
  };
  document.addEventListener("click", used, true);
  document.addEventListener("play", used, true);
  return () => { document.removeEventListener("click", used, true); document.removeEventListener("play", used, true); };
}
export function recordFeatureUsage(feature: Feature, state?: FeatureState): void {
  const current = generation;
  const event: FeatureEvent = state === undefined
    ? { id: crypto.randomUUID(), feature, kind: "use" }
    : { id: crypto.randomUUID(), feature, kind: "state", state };
  const controller = new AbortController();
  pending.add(controller);
  const timer = window.setTimeout(() => controller.abort(), 5_000);
  void piFetch(API.recordFeatureUsage.path(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event), signal: controller.signal }, false)
    .then(async response => {
      if (current === generation && !response.ok) {
        collectionError = `Feature collection failed (${response.status}); some actions are missing.`;
        window.dispatchEvent(new Event("pi-feature-usage-error"));
      }
    }, () => {
      if (current !== generation) return;
      collectionError = "Feature collection is offline; some actions are missing.";
      window.dispatchEvent(new Event("pi-feature-usage-error"));
    }).finally(() => { window.clearTimeout(timer); pending.delete(controller); });
}
