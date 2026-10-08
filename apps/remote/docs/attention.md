# Attention

Open **Attention** at `#/attention` in the browser or Android app. The mixed feed combines [personal decisions and questions](needs-you.md), durable notification updates and [calendar events](calendar.md):

- **Now**: undated or due personal items, active updates/questions and ongoing events in the loaded calendar window.
- **Upcoming**: future personal deadlines and calendar events interleaved by instant. All-day events use the selected display zone for ordering.
- **History**: resolved notifications and finished events in the selected calendar window, newest first. Event editing remains available. **Load earlier updates** pages the durable notification ledger.

A question notification already represented by a linked personal item appears once. Question links select the original question in its source conversation; answers and dismissals stay with that owner. Opening an update opens the original thread, not a copy.

Calendar controls remain on this surface: **New event**, occurrence/series editing and deletion with **Undo**, display zone, optional month selection, **Upcoming**, **Refresh calendars** and **Sync**. The month selector changes the calendar window, not the personal deadlines or updates.

The sources retain their own APIs and encrypted stores. Decisions/questions, updates and calendar load independently; failures remain visible and retained data stays readable. A partial or failed source is not an empty healthy feed. **Refresh** reloads the sources without recording a life reconciliation. **Coverage and delegation** expands the existing source/watch receipts and read-only standing policy.

`#/needs-you`, `#/notifications` and `#/calendar` resolve to Attention. Notification taps and question deep-links still open their source conversation.

Owners: `web/src/attention.tsx` composes the surface; `web/src/attention-model.ts` orders and deduplicates the feed; `web/src/needs-you.tsx`, `web/src/features/notifications/NotificationCard.tsx` and `web/src/calendar.tsx` retain their source-specific cards and controls. There is no combined task, answer or calendar store.
