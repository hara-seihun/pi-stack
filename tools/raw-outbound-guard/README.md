# Raw outbound transport boundary

Owner: Pi Stack `deploy/outbound-transports`, invoked by service-bearing `deploy/host` after selecting the tools release. The command manifest links `signal-cli`, `msmtp` and `sendmail` to this guard in every managed account's `~/.local/bin`. Host deployment installs the same guard at the existing supported raw entrypoints; this is executable enforcement, independent of agent prompts and the `oneKenan` flag.

Dispatch commands fail with exit77 and JSON `canonical-action-required`, `effect:not-dispatched`, before starting a provider or consuming message stdin. Use the canonical `pi-signal` and `pi-mail-send` adapters. There is no approval environment variable or raw-dispatch switch.

## Installed custody

- `/etc/pi-stack/raw-outbound-transports.json` is the root-owned declaration of installed absolute providers. Missing/invalid declarations and missing providers yield typed errors, never a PATH fallback. Signal's canonical supervisor reads this declaration; a profile may explicitly declare an absolute `options.rawExecutable` (or existing `options.binary`), but cannot configure both.
- `/usr/bin/msmtp` is diverted using `dpkg-divert --local --rename` to `/usr/lib/pi-stack/providers/msmtp`. The original absolute entrypoint and `/usr/local/bin/msmtp` point at the selected guard. Package upgrades retain this diversion.
- The installed custom Signal launcher's original path and `/usr/local/bin/signal-cli` point at the guard. Its adjacent `signal-cli-provider` preserves the distribution's relative Java classpath and is declared for the canonical supervisor, including device provisioning. An unregistered preexisting retained launcher refuses installation rather than overwriting evidence.
- `/usr/local/bin/sendmail`, `/usr/local/sbin/sendmail` and account command links point at the guard. `/usr/sbin/sendmail` remains the Postfix system provider; local delivery and existing system notifications are not rerouted through Proton or guessed to be external mail.
- Hosts without these providers receive an explicit empty declaration. Source preparation does not install guards; a service-bearing host activation does. No sealed artifact is edited.

Signal permits known list/get commands, version/help and receive; receive retains Signal's automatic protocol traffic. Unknown commands, registration/account mutation, send/reaction/receipt/typing, JSON-RPC and daemon entrypoints fail closed. `msmtp` permits version/help, explicit server information and pretend diagnostics with a bounded option grammar; queue-start, recipient/send modes and executable `--passwordeval` arguments fail closed. Sendmail permits only exact `-bp`/`-bP` queue reads. Diagnostics can still use provider-owned configuration, including its credential evaluation; they are not a shell sandbox.

## Exact remaining bypasses

These guards do **not** create a credential/UID security boundary:

- The explicit retained Signal launcher, its readable JARs (`org.asamk.signal.Main` through Java), profile-configured absolute providers, and same-UID Signal account stores can dispatch without the agent-facing guard. Canonical Signal uses the retained launcher only after owner action reservation. `options.rawExecutable` is provider configuration, not an agent grant.
- `/usr/lib/pi-stack/providers/msmtp` is intentionally executable for permitted diagnostics. Calling it directly bypasses the guard. Administrator removal of the diversion or replacement of links also bypasses it.
- Active Postfix's absolute `/usr/sbin/sendmail`, `/usr/bin/mailq`/other Postfix commands, and its local submission/queue services remain outside Pi external-action custody. The empty relayhost does not prove that Postfix cannot deliver externally.
- Proton Bridge's authenticated SMTP listener `127.0.0.1:1025` remains reachable directly by `smtplib`, SMTP-capable curl, arbitrary socket programs, or another installed SMTP client. `Agent/Proton Mail Bridge`, `MAIL_BRIDGE_CREDENTIAL_FILE`, the documented delegated credential file, and same-UID credential access still supply credentials. IMAP reads at1143 remain unchanged; Bridge currently uses one credential for both endpoints.
- Same-UID browser sessions, direct provider APIs and administrator/sudo execution are not mediated by these transport guards.

Universal agent enforcement therefore requires a genuine provider UID/credential broker: only that service owns Signal keys and SMTP credentials and only canonical adapters may ask it to dispatch. Bridge's shared IMAP/SMTP credential must stop being an agent-held SMTP capability while mailbox reads continue through a read broker. Shell PATH interception cannot supply that guarantee. No provider accounts, credential values or network permissions are changed here.

## Operations

Host deployment runs `python3 deploy/outbound-transports --tools /srv/pi/tools` as root. It is idempotent and refuses unrelated package diversions. The selected tools tree supplies the guard; the host declaration supplies providers, so upgrading the guard does not replace credentials or mailbox state.

Synthetic acceptance, without real recipients, credentials or provider network traffic:

```sh
python3 -B tools/raw-outbound-guard/test_guard.py
bun test apps/remote/server/messaging/signal-provider.test.ts apps/remote/server/messaging/signal.test.ts
```

Administrator removal is an explicit owning deployment change: unlink the guarded `/usr/bin/msmtp` and remove its local diversion with `dpkg-divert --local --remove --rename --divert /usr/lib/pi-stack/providers/msmtp /usr/bin/msmtp`; restore Signal's original launcher from its declared adjacent provider; remove installed guard links and declaration after changing the command manifest and Signal provider configuration. Preserve Signal account state and Bridge/Postfix mailbox state.
