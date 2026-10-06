package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Before;
import org.junit.Test;

public final class NotificationFeedLeaseTest {
    private final RemoteSession.Identity identity = new RemoteSession.Identity("person", "token");
    @Before public void reset() { NotificationFeedLease.pause(); }

    @Test public void foregroundNeedsInitializedReplayAndLeaseExpiresWithoutActivity() {
        assertFalse(NotificationFeedLease.renew(identity, "home", 0, 100));
        NotificationFeedLease.resume();
        assertFalse(NotificationFeedLease.renew(identity, "home", -1, 100));
        assertTrue(NotificationFeedLease.renew(identity, "home", 0, 100));
        assertTrue(NotificationFeedLease.owns(identity, "home", 25_099));
        assertFalse(NotificationFeedLease.owns(identity, "home", 25_100));
    }

    @Test public void pauseReloadAndIdentityReplacementCannotInheritFeedHealth() {
        NotificationFeedLease.resume();
        NotificationFeedLease.renew(identity, "home", 10, 100);
        assertFalse(NotificationFeedLease.owns(new RemoteSession.Identity("person", "token"), "home", 200));
        NotificationFeedLease.renew(identity, "home", 10, 200);
        NotificationFeedLease.pause();
        assertFalse(NotificationFeedLease.owns(identity, "home", 201));
        NotificationFeedLease.resume();
        assertFalse(NotificationFeedLease.owns(identity, "home", 202));
        NotificationFeedLease.renew(identity, "home", 10, 203);
        NotificationFeedLease.clear();
        assertFalse(NotificationFeedLease.owns(identity, "home", 204));
    }

    @Test public void ownershipIsEnvironmentScopedAndReleaseImmediate() {
        NotificationFeedLease.resume();
        NotificationFeedLease.renew(identity, "home", 10, 100);
        assertFalse(NotificationFeedLease.owns(identity, "lab", 100));
        NotificationFeedLease.release("home");
        assertFalse(NotificationFeedLease.owns(identity, "home", 101));
    }

    @Test public void discoveryAgeIsTimeOfDiscoveryNotTimeOfPollAndRouterIsFenced() {
        for (long now = 30_000; now < 300_000; now += 30_000) assertTrue(IdleNotificationService.discoveryFresh(now, 0, "router", "router"));
        assertFalse(IdleNotificationService.discoveryFresh(300_000, 0, "router", "router"));
        assertFalse(IdleNotificationService.discoveryFresh(30_000, 0, "new-router", "router"));
        assertFalse(IdleNotificationService.discoveryFresh(0, 30_000, "router", "router"));
    }
}
