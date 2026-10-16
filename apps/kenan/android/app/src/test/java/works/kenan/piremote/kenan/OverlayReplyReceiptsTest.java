package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class, shadows = SetupGrantFixture.class)
public class OverlayReplyReceiptsTest {
    private Context context() { return RuntimeEnvironment.getApplication(); }
    private static final String ID = "manager-reply:fixture-manager:fixture-execution";
    private static final String TEXT = "The task is finished.";
    private JSONObject args(String text) throws Exception { return new JSONObject().put("receiptId", ID).put("text", text); }
    private void journal() throws Exception {
        ThreadPoolExecutor actor = ReflectionHelpers.getStaticField(OverlayReplyReceipts.class, "journal");
        actor.submit(() -> {}).get(2, TimeUnit.SECONDS);
    }
    @Before public void prepare() {
        SetupGrantFixture.complete = true;
        Shadows.shadowOf(context().getSystemService(android.os.PowerManager.class)).setIsInteractive(true);
        Shadows.shadowOf(context().getSystemService(android.app.KeyguardManager.class)).setKeyguardLocked(false);
        context().getSharedPreferences("overlay-reply-receipts", 0).edit().clear().commit();
    }
    @After public void clear() throws Exception {
        journal();
        KenanOverlayTest.clearSharedOverlay();
        SetupGrantFixture.complete = true;
    }
    @Test public void acceptedBeforeDrawSurvivesRestartWithoutClaimingDisplayed() {
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        // The fresh reservation reads only disk state, just as a new process does.
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        assertEquals(OverlayReplyReceipts.Reservation.CONFLICT, OverlayReplyReceipts.reserve(context(), "person-a", ID, "Changed"));
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-b", ID, "Changed"));
    }
    @Test public void lostAckAfterDisplayedDeduplicatesFromDiskAndNeverCallsPresenter() throws Exception {
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        assertTrue(OverlayReplyReceipts.displayed(context(), "person-a", ID, TEXT));
        AtomicInteger presentations = new AtomicInteger();
        AtomicReference<PhoneResult> ack = new AtomicReference<>();
        OverlayReplyReceipts.deliver(context(), "person-a", args(TEXT), Long.MAX_VALUE, () -> true,
            (drawn, failed) -> presentations.incrementAndGet(), ack::set);
        journal();
        assertEquals(0, presentations.get());
        assertTrue(ack.get().ok);
        JSONObject result = (JSONObject) ack.get().result;
        assertTrue(result.getBoolean("displayed"));
        assertTrue(result.getBoolean("duplicate"));
        assertEquals(ID, result.getString("receiptId"));
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-b", ID, TEXT));
    }
    @Test public void conflictingReceiptReturnsTypedErrorWithoutRendering() throws Exception {
        OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT);
        AtomicReference<PhoneResult> ack = new AtomicReference<>();
        OverlayReplyReceipts.deliver(context(), "person-a", args("Changed"), Long.MAX_VALUE, () -> true,
            (drawn, failed) -> fail("Conflicting text must not draw"), ack::set);
        journal();
        assertFalse(ack.get().ok);
        assertEquals("receipt_conflict", ack.get().code);
    }
    private KenanOverlay overlay(KenanOverlayTest.Windows windows) {
        var service = Robolectric.buildService(PhoneAccessibilityService.class).get();
        PhoneControlService.settings(service).edit().putBoolean("overlayVisible", true).commit();
        Shadows.shadowOf(service.getSystemService(android.os.PowerManager.class)).setIsInteractive(true);
        Shadows.shadowOf(service.getSystemService(android.app.KeyguardManager.class)).setKeyguardLocked(false);
        KenanOverlay overlay = new KenanOverlay(service, windows.manager());
        overlay.refresh();
        android.view.View scene = ReflectionHelpers.getField(overlay, "scene");
        assertTrue("attached", scene.isAttachedToWindow());
        // The synthetic WindowManager attaches Views but has no system visibility owner.
        Object attachment = ReflectionHelpers.getField(scene, "mAttachInfo");
        ReflectionHelpers.setField(attachment, "mWindowVisibility", android.view.View.VISIBLE);
        assertTrue("shown", scene.isShown());
        assertEquals("window", android.view.View.VISIBLE, scene.getWindowVisibility());
        assertTrue("interactive", service.getSystemService(android.os.PowerManager.class).isInteractive());
        assertFalse("keyguard", service.getSystemService(android.app.KeyguardManager.class).isKeyguardLocked());
        return overlay;
    }
    private void draw(KenanOverlay overlay) throws Exception {
        android.view.View scene = ReflectionHelpers.getField(overlay, "scene");
        scene.layout(0, 0, 360, 800);
        Bitmap bitmap = Bitmap.createBitmap(360, 800, Bitmap.Config.ARGB_8888);
        var method = scene.getClass().getDeclaredMethod("onDraw", Canvas.class);
        method.setAccessible(true);
        method.invoke(scene, new Canvas(bitmap));
        bitmap.recycle();
    }
    @Test public void actualSceneDrawNotCommandAcceptanceCommitsAcknowledgement() throws Exception {
        KenanOverlay overlay = overlay(new KenanOverlayTest.Windows());
        AtomicReference<PhoneResult> ack = new AtomicReference<>();
        OverlayReplyReceipts.deliver(context(), "person-a", args(TEXT), Long.MAX_VALUE, () -> true,
            (drawn, failed) -> overlay.presentReply(TEXT, 20000, Long.MAX_VALUE, () -> true, drawn, failed), ack::set);
        journal(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull("accepted is not displayed: " + (ack.get() == null ? "pending" : ack.get().code + ": " + ack.get().message), ack.get());
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        draw(overlay);
        Shadows.shadowOf(Looper.getMainLooper()).idle(); journal();
        assertTrue(ack.get().ok);
        assertFalse(((JSONObject) ack.get().result).getBoolean("duplicate"));
        assertEquals(OverlayReplyReceipts.Reservation.DISPLAYED, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        overlay.close();
    }
    @Test public void lockingBeforeDrawKeepsReceiptRetryableAndClearsTheBubble() throws Exception {
        KenanOverlay overlay = overlay(new KenanOverlayTest.Windows());
        AtomicReference<PhoneResult> ack = new AtomicReference<>();
        OverlayReplyReceipts.deliver(context(), "person-a", args(TEXT), Long.MAX_VALUE, () -> true,
            (drawn, failed) -> overlay.presentReply(TEXT, 20000, Long.MAX_VALUE, () -> true, drawn, failed), ack::set);
        journal(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(ack.get());
        Context service = ReflectionHelpers.getField(overlay, "service");
        Shadows.shadowOf(service.getSystemService(android.app.KeyguardManager.class)).setKeyguardLocked(true);
        draw(overlay); Shadows.shadowOf(Looper.getMainLooper()).idle(); journal();
        assertFalse(ack.get().ok);
        assertEquals("not_displayed", ack.get().code);
        assertNull(ReflectionHelpers.getField(ReflectionHelpers.getField(overlay, "scene"), "words"));
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        overlay.close();
    }
    @Test public void accountSwitchBeforeDrawClearsVisibleTraceAndKeepsReceiptRetryable() throws Exception {
        KenanOverlay overlay = overlay(new KenanOverlayTest.Windows());
        AtomicReference<PhoneResult> ack = new AtomicReference<>();
        OverlayReplyReceipts.deliver(context(), "person-a", args(TEXT), Long.MAX_VALUE, () -> true,
            (drawn, failed) -> overlay.presentReply(TEXT, 20000, Long.MAX_VALUE, () -> true, drawn, failed), ack::set);
        journal(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(ack.get() == null ? "pending" : ack.get().code + ": " + ack.get().message, ack.get());
        overlay.resetSession();
        assertFalse(ack.get().ok);
        assertEquals("session_expired", ack.get().code);
        Object scene = ReflectionHelpers.getField(overlay, "scene");
        assertNull(ReflectionHelpers.getField(scene, "words"));
        java.util.ArrayDeque<?> transcript = ReflectionHelpers.getField(overlay, "transcript");
        assertTrue(transcript.isEmpty());
        draw(overlay); Shadows.shadowOf(Looper.getMainLooper()).idle(); journal();
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-a", ID, TEXT));
        assertEquals(OverlayReplyReceipts.Reservation.PENDING, OverlayReplyReceipts.reserve(context(), "person-b", ID, TEXT));
        overlay.close();
    }
}
