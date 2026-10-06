import { expect, it } from "vitest";
import { isRunnerCapacityFailure } from "../src/threads/runner-capacity.js";
it("recognizes only explicit runner admission refusals", () => {
  for (const message of ["Runner capacity busy; work remains queued", "Runner capacity busy: memory pressure", "Error: Error: Runner capacity busy; work remains queued"])
    expect(isRunnerCapacityFailure(message)).toBe(true);
  for (const message of ["temporary runner failure", "Thread runner startup has not acknowledged ownership", "Runner is stopping", "Model not found: runner capacity busy", "Runner capacity busy; work remains queued extra", "Runner capacity busy"])
    expect(isRunnerCapacityFailure(message)).toBe(false);
});
