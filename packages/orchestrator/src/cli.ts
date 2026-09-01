#!/usr/bin/env node
import { dispatch } from "./commands.js";

dispatch(process.argv.slice(2)).catch((error)=>{
  console.error(error instanceof Error?error.message:String(error));
  process.exitCode=1;
});
