import {expect, test} from "bun:test";
import {underMemoryPressure} from "./shared-runtime-memory.mjs";

test("admission includes ancestor memory used by other Pi services and browsers", () => {
  const values: Record<string,string> = {
    "/proc/self/cgroup": "0::/pi.slice/pi.service\n",
    "/sys/fs/cgroup/pi.slice/pi.service/memory.max": "1000",
    "/sys/fs/cgroup/pi.slice/pi.service/memory.current": "100",
    "/sys/fs/cgroup/pi.slice/memory.max": "2000",
    "/sys/fs/cgroup/pi.slice/memory.current": "1700",
  };
  expect(underMemoryPressure(path => { if (!(path in values)) throw new Error(path); return values[path]!; })).toBe(true);
  values["/sys/fs/cgroup/pi.slice/memory.stat"] = "anon 900\ninactive_file 800\n";
  expect(underMemoryPressure(path => { if (!(path in values)) throw new Error(path); return values[path]!; })).toBe(false);
  delete values["/sys/fs/cgroup/pi.slice/memory.stat"];
  values["/sys/fs/cgroup/pi.slice/memory.current"] = "1000";
  expect(underMemoryPressure(path => { if (!(path in values)) throw new Error(path); return values[path]!; })).toBe(false);
  expect(underMemoryPressure(() => {throw new Error("not Linux");})).toBe(false);
});
