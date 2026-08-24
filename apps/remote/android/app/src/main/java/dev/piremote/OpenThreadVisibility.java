package dev.piremote;

final class OpenThreadVisibility {
    static final long HEARTBEAT_INTERVAL_MS = 2_000;
    static final long LEASE_TTL_MS = 5_000;

    private OpenThreadVisibility() {}

    static boolean matches(String notificationThreadId, boolean appVisible, String openThreadId,
                           long heartbeatAt, long now) {
        long age = now - heartbeatAt;
        return notificationThreadId != null
            && appVisible
            && notificationThreadId.equals(openThreadId)
            && age >= 0
            && age <= LEASE_TTL_MS;
    }
}
