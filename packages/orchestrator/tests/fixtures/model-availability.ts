import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelAvailabilityStore } from "../../src/threads/model-availability.js";

/** A household policy file that does not exist: every model is enabled. */
export const noModelPolicy = new ModelAvailabilityStore(join(tmpdir(), `pi-no-model-policy-${randomUUID()}`, "policy.json"));
