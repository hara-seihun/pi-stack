import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSignalProvider } from "./signal-provider";

test("Signal provider selection is host-declared, never guessed from PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-provider-"));
  try {
    const declaration = join(root, "providers.json");
    expect(await resolveSignalProvider({}, declaration)).toMatchObject({ ok: false, error: { code: "unconfigured" } });
    await writeFile(declaration, JSON.stringify({ "signal-cli": "/opt/signal/bin/signal-cli-provider" }));
    expect(await resolveSignalProvider({}, declaration)).toEqual({ ok: true, value: "/opt/signal/bin/signal-cli-provider" });
    await writeFile(declaration, "{}");
    expect(await resolveSignalProvider({}, declaration)).toMatchObject({ ok: false, error: { code: "unconfigured" } });
    await writeFile(declaration, "invalid");
    expect(await resolveSignalProvider({}, declaration)).toMatchObject({ ok: false, error: { code: "unconfigured" } });
    expect(await resolveSignalProvider({ rawExecutable: "/fixture/provider" }, declaration)).toEqual({ ok: true, value: "/fixture/provider" });
    expect(await resolveSignalProvider({ binary: "/fixture/provider" }, declaration)).toEqual({ ok: true, value: "/fixture/provider" });
    for (const options of [{ rawExecutable: "signal-cli" }, { binary: "/usr/local/bin/signal-cli" }, { rawExecutable: "" }, { rawExecutable: "/a", binary: "/b" }]) {
      expect(await resolveSignalProvider(options, declaration)).toMatchObject({ ok: false, error: { code: "configuration" } });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
