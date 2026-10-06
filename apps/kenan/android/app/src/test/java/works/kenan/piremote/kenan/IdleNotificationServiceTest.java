package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = Application.class)
public final class IdleNotificationServiceTest {
    @Rule public final MockWebServer server = new MockWebServer();
    private Context context;
    private RemoteSession.Identity identity;
    private ServiceController<IdleNotificationService> controller;
    private IdleNotificationService service;
    private SharedPreferences previousRouter;
    private Field router;
    private Method poll;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        RemoteSession state = NotificationIdentity.get(context);
        state.replace("", "");
        state.replace("person", "token");
        identity = state.current();
        NotificationDelivery.preferences(context).edit().clear().commit();
        NotificationFeedLease.pause();
        router = RouterConnection.class.getDeclaredField("preferences");
        router.setAccessible(true);
        previousRouter = (SharedPreferences) router.get(null);
        SharedPreferences selected = context.getSharedPreferences("test-router", 0);
        selected.edit().putString("router", server.url("/").toString().replaceAll("/+$", "")).commit();
        router.set(null, selected);
        controller = Robolectric.buildService(IdleNotificationService.class).create();
        service = controller.get();
        poll = IdleNotificationService.class.getDeclaredMethod("poll", RemoteSession.Identity.class);
        poll.setAccessible(true);
    }
    @After public void cleanup() throws Exception { controller.destroy(); router.set(null, previousRouter); NotificationFeedLease.pause(); }
    private void discovery(boolean permitted) {
        server.enqueue(new MockResponse().setBody(permitted
            ? "{\"environments\":[{\"id\":\"home\",\"name\":\"Home\",\"baseUrl\":\"\"}]}"
            : "{\"environments\":[]}"));
    }
    private void feed() { server.enqueue(new MockResponse().setBody("{\"environmentId\":\"home\",\"cursor\":0,\"notifications\":[]}")); }
    private void round() throws Exception { poll.invoke(service, identity); }
    private Notification monitoring() { return context.getSystemService(NotificationManager.class).getActiveNotifications()[0].getNotification(); }

    @Test public void cachedDiscoveryActuallyExpiresAndUnchangedNoticeIsNotRebuilt() throws Exception {
        discovery(true); feed(); round();
        assertEquals(2, server.getRequestCount());
        Notification displayed = monitoring();
        for (int i = 0; i < 3; i++) {
            ShadowSystemClock.advanceBy(Duration.ofSeconds(30));
            feed(); round();
            assertSame(displayed, monitoring());
        }
        assertEquals(5, server.getRequestCount());
        ShadowSystemClock.advanceBy(Duration.ofMinutes(5));
        discovery(false); round();
        assertEquals(6, server.getRequestCount());
        assertEquals(-1, NotificationDelivery.cursor(context, "home"));
    }

    @Test public void endpointAuthorizationFailureRediscoveriesWithoutLoggingOutPerson() throws Exception {
        discovery(true); server.enqueue(new MockResponse().setResponseCode(403)); round();
        assertSame(identity, NotificationIdentity.get(context).current());
        discovery(false); round();
        assertEquals(3, server.getRequestCount());
        assertSame(identity, NotificationIdentity.get(context).current());
    }

    @Test public void onlyHealthyForegroundEnvironmentSkipsPollAndPauseRestoresCursorReplay() throws Exception {
        discovery(true); feed(); round();
        NotificationFeedLease.resume();
        assertTrue(NotificationFeedLease.renew(identity, "home", NotificationDelivery.cursor(context, "home"), android.os.SystemClock.elapsedRealtime()));
        round();
        assertEquals(2, server.getRequestCount());
        NotificationFeedLease.pause();
        feed(); round();
        assertEquals(3, server.getRequestCount());
        server.takeRequest(); server.takeRequest();
        assertEquals("/v1/notifications?after=0", server.takeRequest().getPath());
    }
}
