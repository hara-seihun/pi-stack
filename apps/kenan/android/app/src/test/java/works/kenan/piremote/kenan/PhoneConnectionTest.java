package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.app.Application;
import android.content.Context;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import okhttp3.Request;
import okhttp3.WebSocket;
import okio.ByteString;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = Application.class)
public final class PhoneConnectionTest {
    private final List<String> frames = new ArrayList<>();
    private int failures;
    private int cancellations;
    private PhoneConnection connection;
    private Context context;
    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        RemoteSession state = NotificationIdentity.get(context);
        state.replace("", ""); state.replace("person", "token");
        failures = 0; cancellations = 0; frames.clear();
        connection = new PhoneConnection(context, state.current(), "home", () -> true, new PhoneConnection.Events() {
            public void opened(PhoneConnection source) {}
            public void command(PhoneConnection source, JSONObject frame) {}
            public void overlayAck(PhoneConnection source, JSONObject frame) {}
            public void closed(PhoneConnection source, NativeState.PhoneFailure code, String message) { failures++; }
        });
        Field socket = PhoneConnection.class.getDeclaredField("socket"); socket.setAccessible(true);
        socket.set(connection, new WebSocket() {
            public Request request() { return new Request.Builder().url("http://localhost").build(); }
            public long queueSize() { return 0; }
            public boolean send(String text) { frames.add(text); return true; }
            public boolean send(ByteString bytes) { return true; }
            public boolean close(int code, String reason) { return true; }
            public void cancel() { cancellations++; }
        });
        Field ack = PhoneConnection.class.getDeclaredField("lastAcknowledged"); ack.setAccessible(true);
        ack.setLong(connection, android.os.SystemClock.elapsedRealtime());
    }
    @Test public void heartbeatDoesNotResendCapabilitiesAndChangedStatusAdvertisesOnce() throws Exception {
        assertTrue(connection.announceChanges());
        assertTrue(connection.announceChanges());
        assertEquals(1, frames.size());
        connection.heartbeat();
        assertEquals("heartbeat", new JSONObject(frames.get(1)).getString("type"));
        PhoneControlService.settings(context).edit().putString("name", "Changed name").commit();
        assertTrue(connection.announceChanges());
        assertTrue(connection.announceChanges());
        assertEquals(3, frames.size());
        assertEquals("Changed name", new JSONObject(frames.get(2)).getJSONObject("device").getString("name"));
        connection.close();
    }
    @Test public void missingAcknowledgementTerminatesOnceInsteadOfKeepingLeaseAlive() {
        ShadowSystemClock.advanceBy(Duration.ofSeconds(40));
        connection.heartbeat(); connection.heartbeat();
        assertEquals(1, failures);
        assertEquals(1, cancellations);
        assertEquals(0, frames.size());
    }
}
