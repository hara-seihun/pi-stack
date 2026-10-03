# Personal calendar

Open **Calendar** in Pi Remote's navigation rail / bottom bar (`#/calendar`). The default agenda shows the next six months; the month selector shows that month's agenda. **New event**, **Edit** and **Delete** manage owned events. Imported events are marked read-only. Event times carry their IANA zone; the display defaults to the device's local zone and can be changed. All-day dates are independent of display zone; their end date is exclusive.

Each person's supervisor owns `PI_REMOTE_DATA/calendar.sqlite3` and its SQLite WAL/SHM. Use the person's encrypted state directory for `PI_REMOTE_DATA`, as with other Remote personal data. No shared calendar database, event logging or cross-person query exists. The API uses the same router-session / UID-bound caller authorization as phone control. It is independent of Android `calendar.*` phone commands.

## Agent CLI

`deploy/tools` installs `pi-calendar` for every configured account. Run `pi-calendar --help` first. It uses the current thread's `PI_REMOTE_SERVER_URL`, otherwise the current Unix person's registry supervisor. `PI_CALENDAR_URL` can select an explicitly authorized endpoint; router calls use `PI_REMOTE_SESSION`, thread calls use their own capability, local callers use UID-bound transport.

```sh
pi-calendar list --from 2026-10-01T00:00:00Z --to 2026-11-01T00:00:00Z
pi-calendar add --title 'Appointment' --start 2026-10-08T16:30 --end 2026-10-08T17:30 --zone America/Los_Angeles --location 'Telehealth' --notes 'Bring paperwork'
pi-calendar update EVENT_ID --start 2026-10-08T19:30 --end 2026-10-08T20:30 --zone America/Toronto
pi-calendar delete EVENT_ID
pi-calendar add --title Holiday --start 2026-10-08 --end 2026-10-09 --all-day
pi-calendar zone America/Los_Angeles
pi-calendar subscribe --name Work --url 'https://example.org/private.ics' --zone America/Toronto
pi-calendar unsubscribe SUBSCRIPTION_ID
pi-calendar refresh
pi-calendar feed
pi-calendar rotate-feed
```

JSON goes to stdout, failures exit 1. Times without offsets use the event zone. Ambiguous / nonexistent daylight-saving local times are rejected; supply an explicit offset to disambiguate. List windows are limited to two years. Mutations aren't automatically retried; after a transport error, inspect state before issuing them again.

## Repeating owned events

Choose **Daily** or **Weekly** in the event editor. Weekly means the weekday of Start. **Repeat until** is an optional inclusive date in the event zone; blank means indefinitely. Series retain their local start and end clocks across DST, including an end after midnight. All-day repeats retain date spans. Nonexistent DST start times are skipped; ambiguous repeats use the first occurrence. The explicitly offset first event retains its chosen instant.

```sh
pi-calendar add --title 'Dessert night' --start 2026-10-07T19:30 --end 2026-10-07T21:00 --zone America/Los_Angeles --repeat weekly
pi-calendar update EVENT_ID --repeat weekly
pi-calendar update SERIES_ID --scope series --repeat-until 2026-12-31
pi-calendar update SERIES_ID --scope series --repeat-until none
pi-calendar get SERIES_ID
pi-calendar update OCCURRENCE_ID --title 'Just this week'
pi-calendar delete OCCURRENCE_ID
pi-calendar delete SERIES_ID --scope occurrence --occurrence 2026-11-05T03:30:00Z
pi-calendar delete SERIES_ID --scope series
```

Agenda entries have a distinct occurrence ID and `seriesId` / `occurrenceStart` fields. Mutating their ID targets only that occurrence. A repeating base ID requires explicit `--scope series`, or `--scope occurrence --occurrence ORIGINAL_START`. This guard prevents older clients or accidental generic Delete commands from deleting a series. Converting a one-off with `--repeat weekly` needs no scope. `--repeat none` removes repeating behavior. `get` returns the original series anchor, not the clicked occurrence, for whole-series editing.

The UI separates **Edit/Delete this occurrence** from **Edit/Delete whole series**. Both deletion choices ask for confirmation; whole-series confirmation explicitly names all past and future occurrences. A ten-second **Undo** toast restores a deletion. The authenticated undo token lasts ten minutes and refuses to overwrite subsequent changes to that event. An occurrence edit is a stored replacement; deleting one is an exclusion. Whole-series edits retain exceptions keyed to their original scheduled start, so changing the schedule applies only exceptions whose original starts still match the new schedule. Existing one-offs are preserved without conversion or seeding.

Outbound ICS carries one VEVENT with local TZID DTSTART/DTEND, bundled IANA 2026c VTIMEZONE definitions and RRULE, plus EXDATE / RECURRENCE-ID exceptions—not an arbitrary six-month list of copies. Google or other subscribers can expand the series themselves.

## Outbound subscription

Calendar → **Sync → Show subscription link**. The link is a bearer secret: anyone who has it can read **owned events** (not inbound calendars). Shape: `https://HOST/calendar-feed/UNIX_PERSON/64_HEX_TOKEN.ics`. Tokens live only in the person's calendar state. **Rotate link** / `pi-calendar rotate-feed` revokes the previous URL immediately.

Google Calendar (desktop web): **Other calendars → + → From URL**, paste the HTTPS feed URL and add it. Google fetches the URL from its own servers and controls refresh timing; a mesh-only URL does not work there. Apple Calendar uses **File → New Calendar Subscription**. Android ICS subscribers can use a mesh-only URL with the VPN connected. Proton can consume/import ICS according to its current client facilities; this feature isn't a two-way Proton integration.

By default the URL is on the current private entrance. An operator can set `PI_REMOTE_CALENDAR_FEED_BASE` on the supervisor to a dedicated public HTTPS origin and expose **only** GET `/calendar-feed/[person]/[64 hex].ics` through the router. Do not expose `/v1/calendar` or the rest of the router publicly. Disable proxy access/error request logs for this path: URLs contain secrets. The supervisor independently checks the token. Tokens are not copied into the router's state. **Feeds are unavailable while the person's encrypted folder / supervisor is locked**; no plaintext public mirror is maintained.

## Inbound subscriptions

Calendar → **Sync → Add an ICS subscription**: name and subscription URL, then **Subscribe**. Use a Google secret iCal URL or a calendar provider's actual ICS subscription/share URL, not its HTML viewing page. Floating times and date-times without usable zone definitions use the zone selected when subscribing. UTC, IANA TZIDs, embedded VTIMEZONE definitions, all-day events, recurring events, exclusions and recurrence exceptions are supported.

Refresh runs on supervisor startup and every 15 minutes; **Refresh** forces it. Feeds are bounded to 4 MiB and 20-second requests. The last successful encrypted copy remains visible after a failure, with an explicit stale/error indicator. URLs, imported content and refresh status remain in that person's state. Subscription deletion removes its cache. No CalDAV or two-way sync is implemented.

## API

Authenticated `/v1/calendar`: GET agenda with `from` / `to`; POST `/events`; GET, PATCH or DELETE `/events/:id` (mutation query `scope=series|occurrence`, optional `occurrence=ORIGINAL_START`); POST `/undo/:token`; PUT `/settings` with `zone`; POST `/subscriptions` with `name,url,zone`; DELETE `/subscriptions/:id`; POST `/refresh`; GET `/feed`; POST `/feed` rotates. Event fields include `repeat: daily|weekly|null` and `repeatUntil: YYYY-MM-DD|null`; exceptions are managed only through occurrence mutations, not raw event input. Shared browser/server types live in `server/calendar-protocol.ts`. The public router feed route forwards only to the named person's token-checked feed; it never unlocks their folder.
