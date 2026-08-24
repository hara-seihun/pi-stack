package dev.piremote;

import org.junit.Test;
import static org.junit.Assert.*;

public class OpenThreadVisibilityTest {
    @Test public void visibleMatchingThreadSuppressesCompletionNotification() {
        assertTrue(OpenThreadVisibility.matches("thread", true, "thread", 8_000, 10_000));
        assertFalse(OpenThreadVisibility.matches("thread", false, "thread", 8_000, 10_000));
        assertFalse(OpenThreadVisibility.matches("thread", true, "other", 8_000, 10_000));
    }

    @Test public void crashedActivityVisibilityLeaseExpires() {
        assertFalse(OpenThreadVisibility.matches(
            "thread", true, "thread", 1_000, 1_000 + OpenThreadVisibility.LEASE_TTL_MS + 1));
        assertTrue(OpenThreadVisibility.HEARTBEAT_INTERVAL_MS < OpenThreadVisibility.LEASE_TTL_MS);
    }
}
