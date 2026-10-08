import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FeatureUsage } from "./feature-usage";
import { parseFeatureEvent, type FeatureEvent } from "../shared/feature-usage";
const DAY = 86_400_000;
function use(feature: FeatureEvent["feature"]): FeatureEvent { return { id: crypto.randomUUID(), feature, kind: "use" }; }

test("receipt identity is durable, content is rejected, observations stay owner-local", () => {
  const first = new Database(":memory:"); const second = new Database(":memory:");
  const store = new FeatureUsage(first, DAY); const other = new FeatureUsage(second, DAY);
  const event = use("overlay");
  expect(store.record(event, "phone", DAY).ok).toBe(true);
  expect(new FeatureUsage(first, 2 * DAY).record(event, "phone", 2 * DAY)).toEqual({ ok: true, value: { recorded: false } });
  expect(parseFeatureEvent({ ...event, text: "private contents" }).ok).toBe(false);
  expect(parseFeatureEvent({ ...event, feature: "unknown" }).ok).toBe(false);
  const summary = store.summary(2 * DAY); const empty = other.summary(2 * DAY);
  expect(summary.ok && summary.value.features.find(item => item.id === "overlay")!.observations.find(item => item.actor === "phone")!.uses).toBe(1);
  expect(empty.ok && empty.value.features.every(item => item.observations.every(row => row.uses === 0 && row.state === null))).toBe(true);
  first.close(); second.close();
});

test("state refreshes are not usage; count windows expose declining use without inventing history", () => {
  const db = new Database(":memory:"); const store = new FeatureUsage(db, DAY);
  store.record(use("overlay"), "phone", 10 * DAY);
  const state: FeatureEvent = { id: crypto.randomUUID(), feature: "overlay", kind: "state", state: "disabled" };
  store.record(state, "phone", 39 * DAY);
  expect(store.record({ ...state, id: crypto.randomUUID() }, "phone", 40 * DAY)).toEqual({ ok: true, value: { recorded: false } });
  const summary = store.summary(40 * DAY);
  expect(summary.ok).toBe(true);
  if (!summary.ok) return;
  const overlay = summary.value.features.find(item => item.id === "overlay")!.observations.find(item => item.actor === "phone")!;
  expect(overlay).toEqual({ actor: "phone", uses: 1, lastUsedAt: 10 * DAY, last7Days: 0, previous30Days: 1, state: { value: "disabled", observedAt: 39 * DAY } });
  store.record(use("chat"), "human", 150 * DAY);
  expect((db.query("SELECT COUNT(*) n FROM feature_usage_days WHERE day<61").get() as { n: number }).n).toBe(0);
  db.close();
  expect(store.summary().ok).toBe(false);
  expect(store.record(use("chat"), "human").ok).toBe(false);
});
