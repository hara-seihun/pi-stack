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
        RuntimeException addFailure, updateFailure;

        Windows() {
            android.app.Activity activity = Robolectric.buildActivity(android.app.Activity.class).setup().get();
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
                            root.addView(view);
                            assertTrue("fake window must attach its view", view.isAttachedToWindow());
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
