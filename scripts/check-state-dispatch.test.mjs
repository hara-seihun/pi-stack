import { strict as assert } from "node:assert";
import { test } from "node:test";
import { switchDefaults } from "./check-state-dispatch.mjs";

test("rejects switch catch-alls, including nested and minified dispatch", () => {
  assert.equal(switchDefaults('switch (state) { case "idle": break; default: return "working"; }', "app.ts").length, 1);
  assert.equal(switchDefaults('switch(a){case 1:switch(b){default:break}break;default:break}', "app.js").length, 2);
  assert.equal(switchDefaults('switch (state) { default -> "idle"; }', "App.java").length, 1);
  assert.equal(switchDefaults('switch (state) { default: return 0; }', "gateway.c").length, 1);
});
test("allows exhaustive cases, module exports and settings defaults", () => {
  assert.deepEqual(switchDefaults('switch (state) { case "idle": return 0; case "running": return 1; } return assertNever(state); export default { default: true };', "app.ts"), []);
  assert.deepEqual(switchDefaults('String s = "default -> idle"; /* default: */ switch(state) { case IDLE -> 0; case RUNNING -> 1; }', "App.java"), []);
});
