export type CalendarRepeat = "daily" | "weekly";
export type CalendarEvent = { id: string; title: string; start: string; end: string; zone: string; allDay: boolean; location: string; notes: string; updated: string | null; source?: string; readOnly?: boolean; repeat?: CalendarRepeat | null; repeatUntil?: string | null; exceptions?: Record<string, CalendarEvent | null>; seriesId?: string; occurrenceStart?: string };
export type CalendarSubscription = { id: string; name: string; url: string; zone: string; refreshed: string | null; error: string | null };
export type CalendarSnapshot = { events: CalendarEvent[]; subscriptions: CalendarSubscription[]; failures: { subscriptionId: string; error: string }[] };
