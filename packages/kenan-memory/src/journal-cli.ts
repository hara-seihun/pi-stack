#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { ActionJournal, actionJournalEnabled, journalDrainDirectories, type ActionTicket, type ActionSpec, type ActionOutcome } from "./journal.js";
const command = process.argv[2];
const actionJournal = new ActionJournal({ autoDrain: false });
try {
  if (command === "begin") {
    console.log(JSON.stringify(actionJournal.begin(JSON.parse(readFileSync(0, "utf8")) as ActionSpec)));
  } else if (command === "finish") {
    const input = JSON.parse(readFileSync(0, "utf8")) as { ticket: ActionTicket | null; outcome: ActionOutcome; detail?: string };
    if (!["confirmed", "failed", "unconfirmed"].includes(input.outcome)) throw new Error("Invalid action outcome");
    const result = actionJournal.finish(input.ticket, input.outcome, input.detail);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "drain") {
    if (process.argv[3] === "--all") {
      const failures: string[] = [];
      if (actionJournalEnabled()) for (const directory of journalDrainDirectories()) {
        const result = await new ActionJournal({ directory, autoDrain: false }).drain();
        if (!result.ok) failures.push(`${directory}: ${result.error}`);
      }
      console.log(JSON.stringify(failures.length ? { ok: false, errors: failures } : { ok: true }));
      if (failures.length) process.exitCode = 1;
    } else {
      const result = await actionJournal.drain();
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  } else {
    console.log("Usage: journal-cli.ts begin|finish|drain [--all] (begin/finish consume JSON on stdin; never pass message content or credentials in arguments)");
    process.exitCode = command === "--help" ? 0 : 64;
  }
} catch (cause) { console.error(String(cause)); process.exitCode = 1; }
