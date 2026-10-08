# OpenAI surprise-reset observations

Provider-issued surprise resets are a measured phenomenon. These public
observations (as of 2026-08) describe meter recovery; admission uses observed
quota rather than predicting resets.

## Mechanics (confirmed by OpenAI support/staff statements)

- A reset returns usage to 100% remaining and **restarts the 7-day window from
  the next use**. The displayed reset date moves later.
- Unspent balance is **lost, not banked**. Resets are replacements, never
  top-ups ("if you had already consumed 50% of your weekly allowance, you will
  be back at 100% ... and the usage window will restart" — openai/codex#13330).
- The weekly limit is a rolling 7-day usage window anchored at first use, not a
  calendar week (OpenAI_Support, community thread 1364615).
- Resets are sometimes conditional: the 2026-04-28 "ALL paid plans" reset
  excluded some accounts' weekly meters (openai/codex#20395). Treat every reset
  as observable only through the meter itself.
- Referral-banked resets exist and reset both the 5h and weekly windows.

## Observed cadence (public reports, 2026)

Mar 3 (incident compensation), Apr 28, Jun 3, Jul 9 (rollout issue), Aug 9,
Aug 11 ("performative reset"). Users report windows surprise-reset "three or
four times" within a couple of months. Empirical rate: roughly one surprise
reset every 2–4 weeks, occasionally twice within one week.

## Sources

- https://community.openai.com/t/weekly-limits-reset-date-suddenly-changed/1364615
- https://community.openai.com/t/codex-rate-limits-reset-for-all-paid-plans-on-august-9-and-again-on-monday/1389643
- https://community.openai.com/t/questions-about-an-unexpected-codex-usage-reset-and-new-quota-period/1382610
- https://github.com/openai/codex/issues/13330, #16423, #17925, #19987, #20395
- https://help.openai.com/en/articles/11369540-using-codex
