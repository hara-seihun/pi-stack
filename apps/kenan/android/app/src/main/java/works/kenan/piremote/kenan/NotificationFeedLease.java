package works.kenan.piremote.kenan;

import java.util.HashMap;
import java.util.Map;

/** Process-local foreground feed ownership. Expiry never advances a durable replay cursor. */
final class NotificationFeedLease {
    static final long DURATION_MS = 25_000;
    private static final Map<String, Lease> leases = new HashMap<>();
    private static boolean foreground;
    private record Lease(RemoteSession.Identity identity, long expiresAt) {}

    static synchronized void resume() { foreground = true; leases.clear(); }
    static synchronized void pause() { foreground = false; leases.clear(); }
    static synchronized void clear() { leases.clear(); }
    static synchronized void release(String environment) { leases.remove(environment); }
    static synchronized void retain(java.util.Set<String> environments) { leases.keySet().retainAll(environments); }
    static synchronized boolean renew(RemoteSession.Identity identity, String environment, long cursor, long now) {
        if (!foreground || cursor < 0) return false;
        leases.put(environment, new Lease(identity, now + DURATION_MS));
        return true;
    }
    static synchronized boolean owns(RemoteSession.Identity identity, String environment, long now) {
        Lease lease = leases.get(environment);
        if (lease == null) return false;
        if (!foreground || lease.identity != identity || now >= lease.expiresAt) {
            leases.remove(environment);
            return false;
        }
        return true;
    }
}
