/** The runner supplies one async scope per session; ordinary Pi uses its process. */
export function sessionEnvironment(): NodeJS.ProcessEnv {
  return (globalThis as any)[Symbol.for("pi-stack.session-environment")]?.getStore() ?? process.env;
}
