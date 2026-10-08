import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function copyDeploymentOwner(root, checkout) {
  cpSync(join(root, "deploy"), join(checkout, "deploy"), { recursive: true });
}

export function copyRemoteSources(root, checkout, resources) {
  copyDeploymentOwner(root, checkout);
  for (const resource of resources) {
    const destination = join(checkout, resource.source);
    mkdirSync(dirname(destination), { recursive: true });
    if (resource.generated === true) {
      mkdirSync(destination, { recursive: true });
      for (const file of resource.required ?? []) {
        mkdirSync(dirname(join(destination, file)), { recursive: true });
        writeFileSync(join(destination, file), "fixture build output\n");
      }
    } else {
      cpSync(join(root, resource.source), destination, { recursive: true, dereference: resource.dereference === true });
    }
  }
}

export function copyRecognitionSources(root, checkout) {
  cpSync(join(root, "apps/meet-recognition"), join(checkout, "apps/meet-recognition"), { recursive: true });
}
