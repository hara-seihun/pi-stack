import { join } from "node:path";

const privateEnvironment = /^(PI_REMOTE_|PI_SESSION_|AGENT_BROWSER_|SSH_|GIT_|GH_|GITHUB_|MCP_|PI_MCP_)|(?:API_KEY|TOKEN|SECRET|PASSWORD)$/;

export function isolatePiEnvironment(cwd: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment.PI_ORCHESTRATOR_EXECUTION === "root-repair") throw new Error("Root-repair threads require the full normal Pi context");
  const home = join(cwd, ".home");
  Object.assign(environment, { HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), TMPDIR: join(home, ".tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share") });
  for (const key of Object.keys(environment)) if (privateEnvironment.test(key)) delete environment[key];
  return environment;
}
