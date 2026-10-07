package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import android.content.ClipboardManager;
import android.os.Looper;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class PhoneReplayAcceptanceTest {
    private PhoneControlService service;
    private ExecutorService replay;
    private CountDownLatch release;
    private PhoneConnection source;
    private ClipboardManager clipboard;
    private void prepare() throws Exception {
        service = Robolectric.buildService(PhoneControlService.class).get();
        NotificationIdentity.get(service).replace("hara", "test-session");
        RemoteSession.Identity identity = NotificationIdentity.get(service).current();
        PhoneControlService.settings(service).edit().clear().putBoolean("enabled", true)
            .putString("user", "hara").putString("environment", "home").commit();
        ReflectionHelpers.setField(service, "identity", identity);
        ReflectionHelpers.setField(service, "environment", "home");
        source = new PhoneConnection(service, identity, "home", () -> true, new PhoneConnection.Events() {
            public void opened(PhoneConnection connection) {}
            public void command(PhoneConnection connection, JSONObject frame) {}
            public void overlayAck(PhoneConnection connection, JSONObject frame) {}
            public void closed(PhoneConnection connection, NativeState.PhoneFailure code, String message) {}
        });
        ReflectionHelpers.setField(service, "connection", source);
        clipboard = service.getSystemService(ClipboardManager.class);
        clipboard.clearPrimaryClip();
        replay = ReflectionHelpers.getStaticField(PhoneCommandReplay.class, "executor");
        release = new CountDownLatch(1);
        CountDownLatch entered = new CountDownLatch(1);
        replay.execute(() -> {
            entered.countDown();
            try { release.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        });
        assertTrue(entered.await(1, TimeUnit.SECONDS));
    }
    private void receive(String id) throws Exception {
        Method receive = PhoneControlService.class.getDeclaredMethod("receive", PhoneConnection.class, JSONObject.class);
        receive.setAccessible(true);
        receive.invoke(service, source, new JSONObject().put("id", id).put("deadline", System.currentTimeMillis() + 10000)
            .put("command", "clipboard.set").put("args", new JSONObject().put("text", id)));
    }
    private void persist() throws Exception {
        release.countDown();
        replay.submit(() -> {}).get(2, TimeUnit.SECONDS);
    }
    @Test public void acceptancePersistsOffUiBeforeAnyMutationAndSnapshotsStayOrdered() throws Exception {
        prepare();
        receive("first"); receive("second");
        assertFalse(clipboard.hasPrimaryClip());
        assertEquals("[]", PhoneControlService.settings(service).getString("seenCommands", "[]"));
        persist();
        assertFalse("persisting must not mutate UI from the worker", clipboard.hasPrimaryClip());
        JSONArray ledger = new JSONArray(PhoneControlService.settings(service).getString("seenCommands", "[]"));
        assertEquals("first", ledger.getString(0)); assertEquals("second", ledger.getString(1));
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals("second", clipboard.getPrimaryClip().getItemAt(0).getText().toString());
    }
    @Test public void sessionRevocationWhilePersistenceIsPendingCannotMutate() throws Exception {
        prepare(); receive("fenced");
        NotificationIdentity.get(service).replace("", "");
        persist(); shadowOf(Looper.getMainLooper()).idle();
        assertFalse(clipboard.hasPrimaryClip());
        assertEquals("fenced", new JSONArray(PhoneControlService.settings(service).getString("seenCommands", "[]")).getString(0));
    }
    @After public void cleanup() throws Exception {
        if (release != null) release.countDown();
        if (service != null) {
            Method close = PhoneControlService.class.getDeclaredMethod("close");
            close.setAccessible(true);
            close.invoke(service);
            NotificationIdentity.get(service).replace("", "");
            PhoneControlService.settings(service).edit().clear().commit();
        }
    }
}
