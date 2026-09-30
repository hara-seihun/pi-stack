import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSelectionDoctor } from "./model-selection-doctor.mjs";

test("SDK and bundled CLI preserve requested models and fail routing gates without inference", { timeout: 30000 }, async () => {
  const result = await modelSelectionDoctor();
  assert.equal(result.explicitProviderRequests, 1);
  assert.equal(result.admissionFailuresVetoInference, true);
  assert.equal(result.extensionProvidersBeforeSelection, true);
});
