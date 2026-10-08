import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { reconcilePersonTimezoneProjection } from "../src/person-settings.js";
import { settingsError, type PersonTimezone, type SettingsResult } from "../src/person-settings-contract.js";

function reconcile(data: string, file: string): SettingsResult<PersonTimezone | null> {
  const calendarPath = join(data, "calendar.sqlite3");
  try {
    if (existsSync(calendarPath)) {
      const calendar = new Database(calendarPath, { readonly: true });
      try {
        if (calendar.query("SELECT value FROM settings WHERE key='zone'").get()) return settingsError("unavailable", "Owner CalendarStore timezone migration must finish before projection publication");
      } finally { calendar.close(); }
    }
  } catch (error) { return settingsError("unavailable", `Cannot inspect timezone migration: ${error instanceof Error ? error.message : String(error)}`); }
  return reconcilePersonTimezoneProjection(data, file);
}

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--data" || args[2] !== "--file") {
  console.error("Usage: bun person-timezone.ts --data OWN_SETTINGS_DIRECTORY --file OWN_TIMEZONE_PROJECTION");
  process.exitCode = 2;
} else {
  const result = reconcile(args[1], args[3]);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
