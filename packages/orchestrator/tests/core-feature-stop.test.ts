import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedCustodyFlag } from "../src/core/feature-stop.js";
import type { CoreScope } from "../src/core/contracts.js";
test("shared custody honors only the owning registered host feature file and refreshes stop/re-enable", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-feature-")), file = join(dir, "host.json");
  const scope = { environment: { PI_STACK_HOST_CONFIG: file }, resources: [{ path: file, kind: "file" }] } satisfies Pick<CoreScope, "environment" | "resources">;
  const mapped = (path: string) => { expect(path).toBe(file); return path; };
  try {
    expect(sharedCustodyFlag(scope, mapped).state).toBe("unavailable");
    writeFileSync(file, JSON.stringify({ oneKenan: true })); expect(sharedCustodyFlag(scope, mapped).state).toBe("enabled");
    writeFileSync(file, JSON.stringify({ oneKenan: false })); expect(sharedCustodyFlag(scope, mapped).state).toBe("disabled");
    for (const content of ["{", "{}", '{"oneKenan":"true"}']) { writeFileSync(file, content); expect(sharedCustodyFlag(scope, mapped).state).toBe("unavailable"); }
    writeFileSync(file, '{"oneKenan":true}'); expect(sharedCustodyFlag({ ...scope, environment: {} }, mapped).state).toBe("unavailable");
    expect(sharedCustodyFlag({ ...scope, resources: [] }, mapped).state).toBe("unavailable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
