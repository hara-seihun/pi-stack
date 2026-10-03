import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface TracePerson {
  user: string;
  machineAdministrator?: boolean;
  unlock?: { mountpoint: string; cipherDir: string };
  environment?: Record<string, unknown>;
}

export function oneKenanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PI_STACK_HOST_CONFIG ?? env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json";
  return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).oneKenan === true;
}

export function tracePersons(env: NodeJS.ProcessEnv = process.env): TracePerson[] {
  const directory = env.PI_REMOTE_PERSONS_DIR ?? "/var/lib/pi-remote/persons";
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(directory, name), "utf8"))) : [];
}

export function isMachineAdministrator(viewer: string, persons: readonly TracePerson[]): boolean {
  // The registry-marked administrator already has raw access to everything a
  // trace could reveal. The shared execution UID is not the viewer's identity.
  return persons.some(person => person.user === viewer && person.machineAdministrator === true);
}
