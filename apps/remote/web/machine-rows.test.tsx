import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { machineRows, type MachineScreenProps } from "./src/features/machine/MachineScreen";
import { MachineRows, orderedRows } from "./src/features/machine/rows";

const props: MachineScreenProps = { dashboard: null, modelCounts: new Map(), ownerErrors: [], offline: "", syncing: false, features: [], clientRevision: "client", onDismissOwnerError() {}, onReconnect() {} };

test("actionable failure precedes costs, connection, analytics and revision", () => {
  const rows = orderedRows(machineRows({ ...props, offline: "Connection lost", ownerErrors: [{ id: "error", owner: "Runner", message: "Execution failed" }], dashboard: { plans: [], actions: [], modelCounts: [], machine: null, people: null, allowance: { weeklyUsd: 100, usedUsd: 20, resetsAt: "2026-10-12T00:00:00Z" } } }));
  expect(rows.map(row => row.id)).toEqual(["error:error", "connection", "allowance", "host", "revision"]);
  expect(rows[0]!.action).toEqual({ id: "dismiss:error", label: "Dismiss" });
  expect(rows[1]!.action).toEqual({ id: "reconnect", label: "Reconnect" });
});

test("absent telemetry is not manufactured zero usage", () => {
  const rows = machineRows(props);
  expect(rows.find(row => row.id === "dashboard")!.value).toBe("Not loaded");
  const html = renderToStaticMarkup(<MachineRows rows={rows} />);
  expect(html).not.toContain("$0");
  expect(html).not.toContain("0%");
});

test("schema row disclosure retains account values and has one reusable rendering path", () => {
  const row = machineRows(props)[0]!;
  const html = renderToStaticMarkup(<MachineRows rows={[{ ...row, children: [{ ...row, id: "account", label: "Account", value: "23% remaining" }] }]} />);
  expect(html).toContain("<details>");
  expect(html).toContain("23% remaining");
});
