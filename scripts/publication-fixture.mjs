import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function publicationConfig(root, releaseRepository = join(root, "repository")) {
  const path = join(root, "publication-config.json");
  const androidRoot = join(root, "canonical/apps/kenan/android");
  mkdirSync(androidRoot, { recursive: true });
  writeFileSync(join(androidRoot, "local.properties"), "sdk.dir=/fixture/android-sdk\n");
  writeFileSync(path, JSON.stringify({
    repositoryUrl: "https://github.com/hara-seihun/pi-stack.git",
    mergeAuthor: { name: "Fixture publication", email: "fixture@example.test" },
    targets: [
      { id: "gmktec", environmentId: "local", sshHost: null, releaseCommand: join(root, "release"), checkServicesCommand: join(root, "check-services"), releaseRepository,
        hostConfig: join(root, "host.json"), requiredUnits: [], voiceStatusUrl: "http://127.0.0.1:8796/status" },
      { id: "converge", environmentId: "converge", sshHost: "converge-kenan", releaseCommand: join(root, "release"), checkServicesCommand: join(root, "check-services"), releaseRepository,
        androidTransferRoot: join(root, "transfer"), hostConfig: join(root, "host.json"), requiredUnits: [], voiceStatusUrl: "http://127.0.0.1:8796/status" },
    ],
    paths: { canonicalRepository: join(root, "canonical"), installedCommand: join(root, "installed/publication"),
      userUnitRoot: join(root, "units"), repairWorkspaceRoot: join(root, "workspaces"),
      alertInbox: join(root, "inbox"), androidProperties: join(androidRoot, "local.properties") },
  }));
  return path;
}
