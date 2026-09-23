import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function publicationConfig(root, releaseRepository = join(root, "repository")) {
  const path = join(root, "publication-config.json");
  writeFileSync(path, JSON.stringify({
    repositoryUrl: "https://github.com/hara-seihun/pi-stack.git",
    mergeAuthor: { name: "Fixture publication", email: "fixture@example.test" },
    targets: [
      { id: "gmktec", environmentId: "local", sshHost: null, releaseCommand: join(root, "release"), checkServicesCommand: join(root, "check-services"), releaseRepository,
        hostConfig: join(root, "host.json"), requiredUnits: [], voiceStatusUrl: "http://127.0.0.1:8796/status" },
      { id: "converge", environmentId: "converge", sshHost: "converge-kenan", releaseCommand: join(root, "release"), checkServicesCommand: join(root, "check-services"), releaseRepository,
        androidTransferRoot: join(root, "transfer"), hostConfig: join(root, "host.json"), requiredUnits: [], voiceStatusUrl: "http://127.0.0.1:8796/status" },
    ],
    paths: { androidProperties: join(root, "canonical/apps/kenan/android/local.properties") },
  }));
  return path;
}
