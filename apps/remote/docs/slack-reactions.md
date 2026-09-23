# Slack reactions

[`slack-reactions.ts`](../server/slack-reactions.ts) delegates adds to Converge's guarded Slack command. It does not own a Slack token, message store or second API client. Use the endpoint whose person configuration declares that Slack workspace.

A reference is `slack/WORKSPACE_ID/CHANNEL_ID/MESSAGE_TS`. The channel ID starts with `C`, `D` or `G`; the message timestamp is Slack's exact decimal string. A reply's reference uses its own timestamp, with its root timestamp passed separately as `threadTs`. Do not substitute the root for the target message.

## Host configuration

The owning host configures its person registry's environment. This example uses fictional IDs:

```json
"PI_REMOTE_SLACK_REACTIONS": [{
  "workspace": "T12345678",
  "command": ["/opt/converge/converge", "slack", "react"],
  "senderId": "U12345678",
  "senderName": "Kenan"
}]
```

Keep actual routes in the host's maintained provisioning source and person registry. Update the registry with `pi-remote person update USER`. The supervisor reads it on startup, so the next normal release handoff activates the route. Configuring a route grants no Slack permissions by itself; the owning command still enforces them. Credentials stay with that command's existing secret store.

For a configured workspace the adapter invokes the argv array with `--channel`, `--timestamp`, `--emoji`, optional `--thread-ts`, and `--json`. It accepts a confirmed live result containing matching `channel`, `timestamp`, `emoji`, `reacted: true`, `dryRun: false`, and a boolean `alreadyPresent`. Existing reactions count as success. The returned reaction is the caller's confirmed reaction, not a complete platform history. `--dry-run` only previews arguments and is not delivery or permission proof.

Unicode emoji map through `emojibase-data/en/shortcodes/iamcal.json`; explicit custom names such as `:partyparrot:` pass through. Unmapped emoji fail rather than guessing. Missing routes, malformed targets and unsupported removal return structured errors.

## Converge integration

Converge owns `infrastructure/architecture/tools/slack/slack-reaction-sender.ts` and `./converge slack react`. Its audience, channel scope, invocation, assignment, opt-out and effect-authority checks still apply. It currently supports adding reactions to eligible human-authored messages, not removing reactions or reacting to its own bot messages. Another product's bot is not a substitute identity.

The existing Slack-to-Pi mirror supplies source author, channel and exact message timestamp in text, with the topic root in the initial prompt. The supervisor gives the model the configured workspace ID and reference format. To react on Slack, use that source message's Slack reference, not the local `pi/...` reference of the copied prompt. Native imported messages can also carry a structured `identity` with their original Slack reference; the context extension preserves it. It never treats arbitrary message text as trusted identity metadata.

Incoming Slack topics and reactions remain with Converge's Slack integration. This adapter adds no Slack inbox to Remote. The host handbook owns live routes, credentials, source integration receipts and activation.
