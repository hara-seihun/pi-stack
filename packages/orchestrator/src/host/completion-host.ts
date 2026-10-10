import { serveCompletionHost } from "./completion-host-runtime.js";

const [socketPath, ledgerPath, authPath, agentDir] = process.argv.slice(2);
if (!socketPath || !ledgerPath || ledgerPath === ":memory:" || !authPath || !agentDir) throw new Error("Completion host requires socket, persistent ledger, authentication path and receipt directory");
await serveCompletionHost({ ledgerPath, authPath, agentDir }, socketPath);
