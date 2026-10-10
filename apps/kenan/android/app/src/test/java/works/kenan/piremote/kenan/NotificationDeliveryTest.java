package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = Application.class)
public final class NotificationDeliveryTest {
    private Context context;
    private RemoteSession.Identity identity;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        RemoteSession state = NotificationIdentity.get(context);
        state.replace("", "");
        state.replace("person", "session-token");
        identity = state.current();
        NotificationDelivery.preferences(context).edit().clear().commit();
        ThreadNotifications.pause(context);
        ThreadNotifications.clear(context);
        NotificationDelivery.receive(context, identity, "home", "Home", feed(0, false), false);
    }

    private JSONObject feed(long seq, boolean notice) throws Exception {
        JSONArray events = new JSONArray();
        if (notice) events.put(new JSONObject().put("seq", seq).put("sessionId", "running-worker")
            .put("name", "Watch finding").put("kind", "attention").put("body", "Please review — I am still working."));
        return new JSONObject().put("cursor", seq).put("notifications", events);
    }

    @Test public void attentionUsesExistingDeliveryAndPreservesSummaryAndClickTarget() throws Exception {
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, true), true);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        assertEquals(1, manager.getActiveNotifications().length);
        Notification notification = manager.getActiveNotifications()[0].getNotification();
        assertEquals("Please review — I am still working.", notification.extras.getCharSequence(Notification.EXTRA_TEXT));
        assertEquals("Home · Watch finding", notification.extras.getCharSequence(Notification.EXTRA_TITLE));
        assertEquals(NotificationDelivery.CHANNEL, notification.getChannelId());
        assertEquals(0, notification.flags & Notification.FLAG_ONLY_ALERT_ONCE);
        Intent target = shadowOf(notification.contentIntent).getSavedIntent();
        assertEquals("home", target.getStringExtra("environment"));
        assertEquals("running-worker", target.getStringExtra("sessionId"));
        assertEquals("person", target.getStringExtra("user"));
        assertFalse(target.hasExtra("session"));
        assertNull(shadowOf((Application) context).getNextStartedActivity());
        manager.cancelAll();
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, true), false);
        assertEquals(0, manager.getActiveNotifications().length);
        assertEquals("?after=1", NotificationDelivery.query(context, "home"));
    }

    @Test public void monoPolicyCancelsClassicAlertsAndOnlyAllowsExplicitManagerAttention() throws Exception {
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, true), false);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        assertEquals(1, manager.getActiveNotifications().length);
        JSONObject policy = new JSONObject().put("view", "mono").put("managerThreadId", "manager");
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, false).put("policy", policy), false);
        assertEquals(0, manager.getActiveNotifications().length);
        JSONObject managerNotice = feed(2, true).put("policy", policy);
        managerNotice.getJSONArray("notifications").getJSONObject(0).put("sessionId", "manager");
        NotificationDelivery.receive(context, identity, "home", "Home", managerNotice, false);
        assertEquals(1, manager.getActiveNotifications().length);
        JSONObject managerQuestion = feed(3, true).put("policy", policy);
        managerQuestion.getJSONArray("notifications").getJSONObject(0).put("sessionId", "manager").put("kind", "question");
        NotificationDelivery.receive(context, identity, "home", "Home", managerQuestion, false);
        assertEquals(1, manager.getActiveNotifications().length);
        JSONObject childNotice = feed(4, true).put("policy", policy);
        NotificationDelivery.receive(context, identity, "home", "Home", childNotice, false);
        assertEquals(1, manager.getActiveNotifications().length);
        NotificationDelivery.receive(context, identity, "home", "Home", feed(5, true).put("policy", new JSONObject().put("view", "classic")), false);
        assertEquals(2, manager.getActiveNotifications().length);
    }

    @Test public void monoPolicyDropsQueuedClassicToastsBeforeBackgroundDelivery() throws Exception {
        ThreadNotifications.resume(context, null);
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, true), false);
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, false)
            .put("policy", new JSONObject().put("view", "mono").put("managerThreadId", "manager")), false);
        ThreadNotifications.pause(context);
        assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
    }

    @Test public void visibleAttentionIsSuppressedWithoutOpeningAnything() throws Exception {
        ThreadNotifications.resume(context, null);
        ThreadNotifications.select(context, "person", "home", "running-worker");
        NotificationDelivery.receive(context, identity, "home", "Home", feed(1, true), true);
        assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        assertNull(shadowOf((Application) context).getNextStartedActivity());
        ThreadNotifications.pause(context);
    }
}
