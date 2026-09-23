import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const home = homedir();
const defaultPath = "/etc/pi-stack/publication.json";

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function absolute(value, label) {
  if (!isAbsolute(text(value, label)) || /[\s\0]/.test(value)) throw new Error(`${label} must be absolute and contain no whitespace`);
  return value;
}

export function loadPublicationConfig(path = process.env.PI_STACK_PUBLICATION_CONFIG ?? defaultPath) {
  let source;
  try { source = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`cannot read publication config ${path}: ${error.message}`); }
  const repositoryUrl = text(source.repositoryUrl, "repositoryUrl");
  if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+(?:\.git)?$/.test(repositoryUrl) && !/^git@[^:]+:[^/]+\/[^/]+(?:\.git)?$/.test(repositoryUrl))
    throw new Error("repositoryUrl must identify an HTTPS or SSH Git repository");
  const mergeAuthor = {
    name: text(source.mergeAuthor?.name, "mergeAuthor.name"),
    email: text(source.mergeAuthor?.email, "mergeAuthor.email"),
  };
  if (!Array.isArray(source.targets) || !source.targets.length) throw new Error("targets must be a nonempty array");
  const targets = source.targets.map((target, index) => {
    const label = `targets[${index}]`;
    const id = text(target.id, `${label}.id`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`${label}.id is not a safe receipt key`);
    const sshHost = target.sshHost === null ? null : text(target.sshHost, `${label}.sshHost`);
    if (sshHost !== null && !/^[a-zA-Z0-9_.@-]+$/.test(sshHost)) throw new Error(`${label}.sshHost is not an SSH target`);
    return {
      id, sshHost,
      environmentId: text(target.environmentId, `${label}.environmentId`),
      releaseCommand: absolute(target.releaseCommand, `${label}.releaseCommand`),
      checkServicesCommand: absolute(target.checkServicesCommand, `${label}.checkServicesCommand`),
      releaseRepository: absolute(target.releaseRepository, `${label}.releaseRepository`),
      androidTransferRoot: sshHost === null ? null : absolute(target.androidTransferRoot, `${label}.androidTransferRoot`),
      hostConfig: absolute(target.hostConfig ?? "/etc/pi-stack/host.json", `${label}.hostConfig`),
      requiredUnits: Array.isArray(target.requiredUnits) ? target.requiredUnits.map(unit => {
        if (!/^[a-zA-Z0-9@_.-]+\.service$/.test(text(unit, `${label}.requiredUnits`))) throw new Error(`${label}.requiredUnits contains an invalid service unit`);
        return unit;
      }) : (() => { throw new Error(`${label}.requiredUnits must be an array`); })(),
      voiceStatusUrl: text(target.voiceStatusUrl, `${label}.voiceStatusUrl`),
    };
  });
  if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error("target IDs must be unique");
  if (new Set(targets.map(target => target.sshHost)).size !== targets.length) throw new Error("target SSH destinations must be unique");
  if (targets.filter(target => target.sshHost === null).length !== 1) throw new Error("exactly one local target is required");
  const paths = source.paths ?? {};
  const canonicalRepository = absolute(process.env.PI_STACK_PUBLICATION_REPOSITORY ?? paths.canonicalRepository ?? join(home, "projects/pi-stack"), "paths.canonicalRepository");
  return {
    repositoryUrl, mergeAuthor, targets,
    canonicalRepository,
    stateRoot: absolute(process.env.PI_STACK_PUBLICATION_STATE ?? paths.stateRoot ?? join(home, ".local/state/pi-stack-publication"), "paths.stateRoot"),
    installedCommand: absolute(process.env.PI_STACK_PUBLICATION_COMMAND ?? paths.installedCommand ?? join(home, "machine/pi-stack-publication"), "paths.installedCommand"),
    userUnitRoot: absolute(process.env.PI_STACK_PUBLICATION_UNIT_ROOT ?? paths.userUnitRoot ?? join(home, ".config/systemd/user"), "paths.userUnitRoot"),
    repairWorkspaceRoot: absolute(paths.repairWorkspaceRoot ?? join(home, "work/clones"), "paths.repairWorkspaceRoot"),
    piCommand: absolute(process.env.PI_STACK_PUBLICATION_PI ?? paths.piCommand ?? join(home, ".local/bin/pi"), "paths.piCommand"),
    alertInbox: absolute(process.env.PI_STACK_PUBLICATION_ALERT_INBOX ?? paths.alertInbox ?? "/var/lib/machine-alerts/inbox", "paths.alertInbox"),
    androidProperties: absolute(paths.androidProperties ?? join(canonicalRepository, "apps/kenan/android/local.properties"), "paths.androidProperties"),
  };
}
