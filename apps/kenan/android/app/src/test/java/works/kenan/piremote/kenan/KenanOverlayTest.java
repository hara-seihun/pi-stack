package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.accessibilityservice.AccessibilityService;
import android.view.View;
import android.view.WindowManager;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class KenanOverlayTest {
    static final class Windows {
        final Set<View> attached = Collections.newSetFromMap(new IdentityHashMap<>());
        final android.widget.FrameLayout root;
        int adds, updates, removes;
        int failAdd;
        boolean deferAttachment;
        RuntimeException addFailure, updateFailure;

        Windows() {
            android.app.Activity activity = Robolectric.buildActivity(android.app.Activity.class).setup().visible().get();
            root = new android.widget.FrameLayout(activity);
            activity.setContentView(root);
        }
        WindowManager manager() {
            return (WindowManager) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{WindowManager.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "addView" -> {
                            if (++adds == failAdd) throw addFailure;
                            View view = (View) args[0];
                            assertTrue("view added twice", attached.add(view));
                            if (!deferAttachment) {
                                root.addView(view);
                                assertTrue("fake window must attach its view", view.isAttachedToWindow());
                            }
                        }
                        case "updateViewLayout" -> {
                            updates++;
                            if (updateFailure != null) throw updateFailure;
                            if (!attached.contains(args[0])) throw new IllegalArgumentException("Window was detached");
                        }
                        case "removeView", "removeViewImmediate" -> {
                            removes++;
                            if (!attached.remove(args[0])) throw new IllegalArgumentException("Window was already removed");
                            root.removeView((View) args[0]);
                        }
                        default -> throw new AssertionError("Unexpected WindowManager call: " + method.getName());
                    }
                    return null;
                });
        }
    }

    private static void shared(String name, Object value) throws Exception {
        Field field = SharedOverlay.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(null, value);
    }
    static void bindSharedOverlay(AccessibilityService owner, PhoneAccessibilityService phone,
        WriteAccessibilityService write, KenanOverlay overlay) throws Exception {
        shared("owner", owner);
        shared("phone", phone);
        shared("write", write);
        shared("overlay", overlay);
    }
    static void clearSharedOverlay() throws Exception {
        KenanOverlay overlay = SharedOverlay.current();
        bindSharedOverlay(null, null, null, null);
        if (overlay != null) overlay.close();
        Field active = WriteAccessibilityService.class.getDeclaredField("active");
        active.setAccessible(true);
        active.set(null, null);
    }
    @After public void clearSharedOwner() throws Exception { clearSharedOverlay(); }

    private KenanOverlay overlay(Windows windows) {
        WriteAccessibilityService service = Robolectric.buildService(WriteAccessibilityService.class).get();
        return new KenanOverlay(service, windows.manager());
    }
    private void position(KenanOverlay overlay) throws Exception {
        Method position = KenanOverlay.class.getDeclaredMethod("position", int.class, int.class);
        position.setAccessible(true);
        position.invoke(overlay, 10, 10);
    }

    private Object field(KenanOverlay overlay, String name) throws Exception {
        Field field = KenanOverlay.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(overlay);
    }
    private KenanOverlay phoneOverlay(Windows windows) throws Exception {
        PhoneAccessibilityService service = Robolectric.buildService(PhoneAccessibilityService.class).get();
        KenanOverlay overlay = new KenanOverlay(service, windows.manager());
        bindSharedOverlay(service, service, null, overlay);
        overlay.refresh();
        return overlay;
    }
    private void drawDot(View dot) throws Exception {
        Method draw = dot.getClass().getDeclaredMethod("onDraw", android.graphics.Canvas.class);
        draw.setAccessible(true);
        draw.invoke(dot, new android.graphics.Canvas());
    }
    @Test public void idleDotHasNoRecurringFrameButActiveWorkDoes() throws Exception {
        KenanOverlay overlay = phoneOverlay(new Windows());
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        View dot = (View) field(overlay, "dot");
        Object attachment = org.robolectric.util.ReflectionHelpers.getField(dot, "mAttachInfo");
        org.robolectric.util.ReflectionHelpers.setField(attachment, "mWindowVisibility", View.VISIBLE);
        assertTrue("test dot must be visible", dot.isShown());
        assertEquals(View.VISIBLE, dot.getWindowVisibility());
        drawDot(dot);
        org.robolectric.Shadows.shadowOf(dot).clearWasInvalidated();
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(220));
        assertFalse("idle decoration must not schedule redraws", org.robolectric.Shadows.shadowOf(dot).wasInvalidated());
        overlay.state("thinking");
        drawDot(dot);
        org.robolectric.Shadows.shadowOf(dot).clearWasInvalidated();
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(45));
        assertTrue("actual work must remain animated", org.robolectric.Shadows.shadowOf(dot).wasInvalidated());
    }
    @Test public void disconnectSettlesAcknowledgedBusyState() throws Exception {
        KenanOverlay overlay = phoneOverlay(new Windows());
        overlay.state("working");
        assertTrue(((java.util.Map<?, ?>) field(overlay, "pending")).isEmpty());
        overlay.disconnected();
        assertEquals(NativeState.OverlayAnimation.IDLE, field(overlay, "state"));
    }
    @Test public void unchangedRefreshDoesNotInvalidateOrRepositionWindows() throws Exception {
        Windows windows = new Windows();
        KenanOverlay overlay = phoneOverlay(windows);
        overlay.refreshGeometry();
        View dot = (View) field(overlay, "dot"), scene = (View) field(overlay, "scene");
        org.robolectric.Shadows.shadowOf(dot).clearWasInvalidated();
        org.robolectric.Shadows.shadowOf(scene).clearWasInvalidated();
        int updates = windows.updates;
        overlay.refresh(); overlay.refreshGeometry();
        assertEquals(updates, windows.updates);
        assertFalse(org.robolectric.Shadows.shadowOf(dot).wasInvalidated());
        assertFalse(org.robolectric.Shadows.shadowOf(scene).wasInvalidated());
    }
    @Test public void failedWindowAttachmentClosesAndRollsBackEveryAddedView() {
        RuntimeException[] failures = {
            new WindowManager.BadTokenException("Service token expired"),
            new SecurityException("Accessibility overlay permission revoked"),
            new WindowManager.InvalidDisplayException("Display was removed")
        };
        for (RuntimeException failure : failures) {
            for (int failedAdd = 1; failedAdd <= 2; failedAdd++) {
                Windows windows = new Windows();
                windows.failAdd = failedAdd;
                windows.addFailure = failure;

                KenanOverlay overlay = overlay(windows);

                assertTrue(failure.getClass().getSimpleName() + " on add " + failedAdd, overlay.closed());
                assertEquals(failedAdd, windows.adds);
                assertTrue("partial attachment leaked a window", windows.attached.isEmpty());
                int removed = windows.removes;
                overlay.close();
                overlay.refresh();
                assertEquals(removed, windows.removes);
                assertEquals(0, windows.updates);
            }
        }
    }
    @Test public void failedDotAttachmentRemovesSceneBeforeItsFirstFrame() {
        Windows windows = new Windows();
        windows.deferAttachment = true;
        windows.failAdd = 2;
        windows.addFailure = new WindowManager.BadTokenException("Service token expired before first frame");
        assertTrue(overlay(windows).closed());
        assertEquals(1, windows.removes);
        assertTrue(windows.attached.isEmpty());
    }
    @Test public void detachedPositionUpdateClosesOverlayInsteadOfCrashing() throws Exception {
        Windows windows = new Windows();
        KenanOverlay overlay = overlay(windows);
        assertFalse(overlay.closed());
        assertEquals(2, windows.attached.size());
        windows.updateFailure = new IllegalArgumentException("Window was detached");

        position(overlay);

        assertTrue(overlay.closed());
        assertEquals(1, windows.updates);
        assertTrue(windows.attached.isEmpty());
        int removed = windows.removes;
        position(overlay);
        overlay.refresh();
        overlay.close();
        assertEquals(1, windows.updates);
        assertEquals(removed, windows.removes);
    }
    @Test public void closeRemovesAllWindowsOnlyOnce() {
        Windows windows = new Windows();
        KenanOverlay overlay = overlay(windows);

        overlay.close();
        overlay.close();
        overlay.refresh();

        assertTrue(overlay.closed());
        assertEquals(2, windows.removes);
        assertTrue(windows.attached.isEmpty());
        assertEquals(0, windows.updates);
    }
    @Test public void alreadyRemovedWindowsDoNotInterruptClose() {
        Windows windows = new Windows();
        KenanOverlay overlay = overlay(windows);
        windows.attached.clear();

        overlay.close();
        overlay.close();

        assertTrue(overlay.closed());
        assertEquals("both removals must be attempted even when the first view is detached", 2, windows.removes);
    }
}
