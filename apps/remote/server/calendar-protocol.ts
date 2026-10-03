export type CalendarEvent = { id: string; title: string; start: string; end: string; zone: string; allDay: boolean; location: string; notes: string; updated: string; source?: string; readOnly?: boolean };
export type CalendarSubscription = { id: string; name: string; url: string; zone: string; refreshed: string | null; error: string | null };
export type CalendarSnapshot = { events: CalendarEvent[]; subscriptions: CalendarSubscription[]; zone: string };
