# Publication custody

This Pi extension keeps source publication out of model sessions. Once a repository accepts an immutable commit into its durable publication queue, that queue owns checks, merge, deployment, verification, supersession, and failure reporting.

The extension blocks shell constructs that keep a model alive to watch GitHub checks. One-shot status and failed-log reads still work for explicit audits and repair tasks.

Repository policy must provide the durable handoff. This extension does not pretend that a push alone is custody transfer, and it does not run CI or deployment itself.

## Test

```sh
npm test --workspace=@hara-seihun/publication-custody
```
