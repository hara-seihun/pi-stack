import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appUpdateResponse, isAppRelease, isWebRelease, type AppRelease, type WebRelease } from "./app-update";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-app-update-"));
  directories.push(root);
  const bytes = Buffer.from("APK bytes");
  const revision = "a".repeat(40);
  const release: AppRelease = { revision, versionCode: 1100, applicationId: "works.kenan.piremote.kenan", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: `${revision}.apk`, shellId: "0123456789abcdef" };
  const webBytes = Buffer.from("web bundle bytes");
  const web: WebRelease = { revision, versionCode: 1100, applicationId: "works.kenan.piremote.kenan", shellId: "0123456789abcdef", size: webBytes.length, sha256: createHash("sha256").update(webBytes).digest("hex"), fileName: `${revision}.web.zip` };
  const directory = join(root, "releases", revision);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify(release));
  await writeFile(join(directory, release.fileName), bytes);
  await writeFile(join(directory, "web-manifest.json"), JSON.stringify(web));
  await writeFile(join(directory, web.fileName), webBytes);
  await symlink(`releases/${revision}`, join(root, "current"));
  return { root, directory, bytes, release, web, webBytes };
}
const request = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });

test("manifest, APK and web bundle are available without a selected or unlocked person", async () => {
  const { root, bytes, release, web, webBytes } = await fixture();
  const response = await appUpdateResponse(request("/v1/app-update"), root);
  expect(await response!.json()).toEqual({ release, web });
  const bundle = await appUpdateResponse(request(`/v1/app-update/${web.fileName}`), root);
  expect(Buffer.from(await bundle!.arrayBuffer())).toEqual(webBytes);
  expect(bundle!.headers.get("content-type")).toBe("application/zip");
  expect(bundle!.headers.get("etag")).toBe(`"${web.sha256}"`);
  expect(response!.headers.get("cache-control")).toBe("no-store");
  const apk = await appUpdateResponse(request(`/v1/app-update/${release.fileName}`), root);
  expect(Buffer.from(await apk!.arrayBuffer())).toEqual(bytes);
  expect(apk!.headers.get("content-type")).toBe("application/vnd.android.package-archive");
  const head = await appUpdateResponse(request(`/v1/app-update/${release.fileName}`, "HEAD"), root);
  expect(head!.headers.get("content-length")).toBe(String(bytes.length));
  expect(await head!.text()).toBe("");
});

test("unpublished, broken, and unrelated routes have distinct outcomes", async () => {
  const { root, directory, release } = await fixture();
  expect(await appUpdateResponse(request("/v1/health"), root)).toBeNull();
  expect((await appUpdateResponse(request("/v1/app-update", "POST"), root))!.status).toBe(405);
  expect((await appUpdateResponse(request("/v1/app-update/not-an-apk"), root))!.status).toBe(404);
  await writeFile(join(directory, release.fileName), "x");
  expect((await appUpdateResponse(request(`/v1/app-update/${release.fileName}`), root))!.status).toBe(503);
  await writeFile(join(directory, `${release.revision}.web.zip`), "x");
  expect((await appUpdateResponse(request(`/v1/app-update/${release.revision}.web.zip`), root))!.status).toBe(503);
  await writeFile(join(directory, "web-manifest.json"), "broken");
  expect((await appUpdateResponse(request("/v1/app-update"), root))!.status).toBe(503);
  await rm(join(directory, "web-manifest.json"));
  expect(await (await appUpdateResponse(request("/v1/app-update"), root))!.json()).toEqual({ release, web: null });
  expect((await appUpdateResponse(request(`/v1/app-update/${release.revision}.web.zip`), root))!.status).toBe(404);
  await writeFile(join(directory, "manifest.json"), "broken");
  expect((await appUpdateResponse(request("/v1/app-update"), root))!.status).toBe(503);
  await rm(join(root, "current"));
  expect(await (await appUpdateResponse(request("/v1/app-update"), root))!.json()).toEqual({ release: null, web: null });
});

test("publication installs immutable packages with their web bundles, rejects rollback, and retains three generations", async () => {
  const { root, bytes, release, web, webBytes } = await fixture();
  const source = join(root, "source");
  await mkdir(source);
  const install = () => spawnSync(process.execPath, [join(import.meta.dir, "../../../deploy/android-update"), "install", source], {
    env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: root }, encoding: "utf8", timeout: 5_000,
  });
  for (let index = 1; index <= 3; index++) {
    const revision = String(index).repeat(40);
    const next = { ...release, revision, versionCode: release.versionCode + index, fileName: `${revision}.apk` };
    const nextWeb = index === 2 ? null : { ...web, revision, versionCode: next.versionCode, fileName: `${revision}.web.zip` };
    await rm(source, { recursive: true, force: true });
    await mkdir(source);
    await writeFile(join(source, "manifest.json"), JSON.stringify(next));
    await writeFile(join(source, next.fileName), bytes);
    if (nextWeb) {
      await writeFile(join(source, "web-manifest.json"), JSON.stringify(nextWeb));
      await writeFile(join(source, nextWeb.fileName), webBytes);
    }
    const result = install();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ...next, web: nextWeb });
    expect(await (await appUpdateResponse(request("/v1/app-update"), root))!.json()).toEqual({ release: next, web: nextWeb });
    if (nextWeb) expect(Buffer.from(await (await appUpdateResponse(request(`/v1/app-update/${nextWeb.fileName}`), root))!.arrayBuffer())).toEqual(webBytes);
  }
  expect((await appUpdateResponse(request(`/v1/app-update/${release.fileName}`), root))!.status).toBe(404);
  await writeFile(join(source, "web-manifest.json"), JSON.stringify({ ...web, revision: "4".repeat(40), fileName: `${"4".repeat(40)}.web.zip` }));
  expect(install().stderr).toContain("does not belong to the app release");
  await rm(source, { recursive: true, force: true });
  await mkdir(source);
  await writeFile(join(source, "manifest.json"), JSON.stringify(release));
  await writeFile(join(source, release.fileName), bytes);
  expect(install().stderr).toContain("Refusing to replace");
  const latest = { ...release, revision: "3".repeat(40), versionCode: release.versionCode + 3, fileName: `${"3".repeat(40)}.apk` };
  await writeFile(join(source, "manifest.json"), JSON.stringify(latest));
  await writeFile(join(source, latest.fileName), "x");
  expect(install().stderr).toContain("does not match its manifest");
});

test("release manifests cannot name arbitrary files or invalid versions", async () => {
  const { release, web } = await fixture();
  expect(isAppRelease(release)).toBe(true);
  expect(isAppRelease({ ...release, shellId: undefined })).toBe(true);
  expect(isAppRelease({ ...release, shellId: "nope" })).toBe(false);
  expect(isWebRelease(web)).toBe(true);
  expect(isWebRelease({ ...web, fileName: `${web.revision}.apk` })).toBe(false);
  expect(isWebRelease({ ...web, shellId: undefined })).toBe(false);
  expect(isWebRelease({ ...web, size: 50 * 1024 * 1024 + 1 })).toBe(false);
  expect(isAppRelease({ ...release, fileName: "../../secret" })).toBe(false);
  expect(isAppRelease({ ...release, versionCode: 97 })).toBe(false);
  expect(isAppRelease({ ...release, size: 0 })).toBe(false);
  expect(isAppRelease({ ...release, applicationId: "another.app" })).toBe(false);
});
