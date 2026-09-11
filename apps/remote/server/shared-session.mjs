import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createBashTool, SessionManager } from '@earendil-works/pi-coding-agent';

const sdk = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { runSharedRpcMode } = await import(pathToFileURL(join(sdk, 'modes/rpc/shared-rpc-mode.js')).href);

export async function openSession({ cwd, args, env }, output, exit) {
  const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const extensions = args.flatMap((arg, i) => arg === '--extension' ? [args[i + 1]] : []);
  const agentDir = env.PI_CODING_AGENT_DIR;
  const sessionManager = value('--session')
    ? SessionManager.open(value('--session'), undefined, cwd)
    : SessionManager.create(cwd, value('--session-dir'));
  const factory = async ({ cwd: targetCwd, sessionManager: manager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({cwd: targetCwd, agentDir,
      resourceLoaderOptions: {additionalExtensionPaths: extensions}});
    const errors = services.resourceLoader.getExtensions().errors;
    if (errors.length) throw new Error(`Session extensions failed: ${JSON.stringify(errors)}`);
    const provider = value('--provider'), modelId = value('--model');
    const model = provider && modelId ? services.modelRuntime.getModel(provider, modelId) : undefined;
    if (provider && modelId && !model) throw new Error(`Model not found: ${provider}/${modelId}`);
    const bash = createBashTool(targetCwd, {spawnHook: context => ({...context,
      env: {...context.env, ...env, PI_REMOTE_CONTEXT_OWNER_PID: String(process.pid)}})});
    const created = await createAgentSessionFromServices({services, sessionManager: manager, sessionStartEvent,
      model, thinkingLevel: value('--thinking'), customTools: [bash]});
    return {...created, services, diagnostics: services.diagnostics};
  };
  const runtime = await createAgentSessionRuntime(factory, {cwd, agentDir, sessionManager});
  if (value('--name')) runtime.session.setSessionName(value('--name'));
  try { return await runSharedRpcMode(runtime, {output, exit}); }
  catch (error) { await runtime.dispose(); throw error; }
}
