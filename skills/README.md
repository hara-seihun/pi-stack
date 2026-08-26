# skills

Shared agent skills from the Pi stack. Each top-level directory is one skill
in standard Pi skill layout. Host deployment links the skills it wants into
the agent's skill directory.

## Skills

- [`software-engineering`](software-engineering/SKILL.md) — mandatory
  software-engineering principles and defaults for agents.
- [`charisma`](charisma/SKILL.md) — how a voice agent should behave in live
  meetings and calls: register, hedging, agreement, humour, and pacing.
- [`unslop`](unslop/SKILL.md) — cut AI tells from any prose a person will
  read, and put a voice back in. Applies to every register.
- [`mcp-fix`](mcp-fix/SKILL.md) — work the `lemma.ing` server's own feedback
  queue end to end: read everything agents filed against the MCP server, broken
  and missing both, work out the best way to implement each, ship it, and close
  it out with what changed. Loads `software-engineering` first. Paths inside are
  for the `kenan` machine, which is where that server is developed and deployed
  from.

## Deployment on a machine

[`config/skill-sets.json`](../config/skill-sets.json) declares each host role. Publish all skill files under `/srv/pi/skills` and link the selected role into an agent directory with:

```bash
deploy/skills converge-user
```

Set `PI_AGENT_DIR` when deploying another user, such as the GMKtec fleet account. The deployed directory records the Pi stack commit.
