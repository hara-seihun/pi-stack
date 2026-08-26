# hara-messages

`hara-messages` extracts Hara's user-role messages from Pi session JSONL files and reports session, message, character, word, and token counts. Profiles select sessions by working-directory root. Session IDs are deduplicated across Pi Remote and local stores.

```bash
hara-messages
hara-messages --profile personal
hara-messages --match cayley --min-msgs 4 --list
hara-messages --out /tmp/transcript.txt
```

Malformed JSONL records are skipped. `--out` writes the timestamped message corpus; without it the command prints counts only.
