package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class PhoneAccessibilityServiceTest {
    private AccessibilityWindowInfo window(int id, int type) {
        AccessibilityWindowInfo window = AccessibilityWindowInfo.obtain();
        shadowOf(window).setId(id); shadowOf(window).setType(type);
        return window;
    }
    private AccessibilityEvent event(int id, int type, String name) {
        AccessibilityEvent event = AccessibilityEvent.obtain(type);
        shadowOf(event).setWindowId(id); event.setPackageName(name);
        return event;
    }
    @Test public void selfAndImeEventsPreserveAppContextAndCachedNodes() throws Exception {
        PhoneAccessibilityService service = Robolectric.buildService(PhoneAccessibilityService.class).get();
        shadowOf(service).setWindows(List.of(window(1, AccessibilityWindowInfo.TYPE_APPLICATION),
            window(2, AccessibilityWindowInfo.TYPE_INPUT_METHOD), window(3, AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY)));
        KenanOverlay overlay = new KenanOverlay(service, new KenanOverlayTest.Windows().manager());
        KenanOverlayTest.bindSharedOverlay(service, service, null, overlay);
        SharedOverlay.requestRefresh(false);
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(80));
        Map<String, AccessibilityNodeInfo> nodes = ReflectionHelpers.getField(service, "nodes");
        nodes.put("cached", AccessibilityNodeInfo.obtain());
        service.onAccessibilityEvent(event(1, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED, "example.editor"));
        nodes.put("cached", AccessibilityNodeInfo.obtain());
        service.onAccessibilityEvent(event(2, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED, "example.keyboard"));
        service.onAccessibilityEvent(event(2, AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, "example.keyboard"));
        service.onAccessibilityEvent(event(3, AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, service.getPackageName()));
        assertEquals(1, nodes.size());
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(80));
        assertEquals("example.editor", ReflectionHelpers.getField(service, "foregroundPackage"));
        service.onAccessibilityEvent(event(1, AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, "example.editor"));
        assertTrue(nodes.isEmpty());
        service.onDestroy();
    }
    @After public void cleanup() throws Exception { KenanOverlayTest.clearSharedOverlay(); }
}
