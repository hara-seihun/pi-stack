#!/usr/bin/env node
import { dispatch } from "./commands.js";

const args = process.argv.slice(2);
const operation = args[0] === "model-broker"
  ? import("./model-broker.js").then(({ runModelBroker }) => {
    if (args.length !== 2) throw new Error("Usage: pi-orchestrator model-broker /etc/pi-model-broker.json");
    return runModelBroker(args[1]);
  })
  : dispatch(args);
operation.catch((error)=>{
  console.error(error instanceof Error?error.message:String(error));
  process.exitCode=1;
});
