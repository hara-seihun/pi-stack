package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import android.view.accessibility.AccessibilityNodeInfo;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class WriteAccessibilityServiceTest {
    private Object get(WriteAccessibilityService service, String name) throws Exception {
        Field field = WriteAccessibilityService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(service);
    }
    private void set(WriteAccessibilityService service, String name, Object value) throws Exception {
        Field field = WriteAccessibilityService.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(service, value);
    }
    private void call(WriteAccessibilityService service, String name, String value) throws Exception {
        Method method = WriteAccessibilityService.class.getDeclaredMethod(name, String.class);
        method.setAccessible(true);
        method.invoke(service, value);
    }
    private WriteAccessibilityService withActiveSender() throws Exception {
        WriteAccessibilityService service = Robolectric.buildService(WriteAccessibilityService.class).get();
        set(service, "generation", 42L);
        set(service, "finishing", true);
        ArrayList<byte[]> packets = new ArrayList<>() {
            @Override public void clear() {
                try {
                    assertTrue("sender must be fenced before its backing list disappears", (long) WriteAccessibilityServiceTest.this.get(service, "generation") > 42);
                    assertNull(WriteAccessibilityServiceTest.this.get(service, "connection"));
                } catch (Exception error) { throw new AssertionError(error); }
                super.clear();
            }
        };
        packets.add(new byte[]{1, 2});
        set(service, "packets", packets);
        return service;
    }
    private AccessibilityNodeInfo editable(String text, boolean hint) {
        AccessibilityNodeInfo node = AccessibilityNodeInfo.obtain();
        node.setEditable(true);
        node.setEnabled(true);
        node.setFocused(true);
        node.setText(text);
        node.setHintText("Type a message");
        node.setShowingHintText(hint);
        node.setTextSelection(text == null ? -1 : text.length(), text == null ? -1 : text.length());
        return node;
    }
    private void assertInserted(AccessibilityNodeInfo node, String dictated, String expected) throws Exception {
        WriteAccessibilityService service = withActiveSender();
        set(service, "target", node);
        set(service, "windowId", node.getWindowId());
        shadowOf(node).setOnPerformActionListener((action, args) -> true);
        call(service, "completed", dictated);
        var actions = shadowOf(node).getPerformedActionsWithArgs();
        assertEquals(AccessibilityNodeInfo.ACTION_SET_TEXT, (int) actions.get(0).first);
        assertEquals(expected, actions.get(0).second.getCharSequence(
            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE).toString());
        assertEquals(expected.length(), actions.get(1).second.getInt(
            AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT));
        assertFalse((boolean) get(service, "clipboardReady"));
    }
    @Test public void hintIsNeitherDictationContextNorInsertedContent() throws Exception {
        AccessibilityNodeInfo node = editable("Type a message", true);
        assertEquals("", WriteAccessibilityService.fieldText(node));
        assertInserted(node, "Hello there", "Hello there");
    }
    @Test public void typedTextMatchingHintRemainsRealContent() throws Exception {
        AccessibilityNodeInfo node = editable("Type a message", false);
        assertEquals("Type a message", WriteAccessibilityService.fieldText(node));
        assertInserted(node, "please", "Type a message please");
    }
    @Test public void emptyFieldWithSeparateHintInsertsOnlyDictation() throws Exception {
        AccessibilityNodeInfo node = editable(null, false);
        assertEquals("", WriteAccessibilityService.fieldText(node));
        assertInserted(node, "Hello", "Hello");
    }
    @Test @Config(sdk = 24) public void fieldTextSupportsAndroidBeforeHintFlag() {
        AccessibilityNodeInfo node = AccessibilityNodeInfo.obtain();
        node.setText("Existing text");
        assertEquals("Existing text", WriteAccessibilityService.fieldText(node));
    }
    @Test public void emptyResultFencesSenderBeforeClearingAudio() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        call(service, "completed", "");
        assertFalse((boolean) get(service, "finishing"));
        assertEquals(0, ((ArrayList<?>) get(service, "packets")).size());
    }
    @Test public void clipboardResultAlsoRetiresSender() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        call(service, "completed", "dictated text");
        assertTrue((boolean) get(service, "clipboardReady"));
        assertFalse((boolean) get(service, "finishing"));
        long retired = (long) get(service, "generation");
        call(service, "completed", "late duplicate");
        assertEquals(retired, (long) get(service, "generation"));
    }
    @Test public void failedAttemptFencesSenderBeforeClearingAudio() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        call(service, "failed", "connection lost");
        assertFalse((boolean) get(service, "finishing"));
    }
    @After public void clearSharedOwner() throws Exception {
        KenanOverlayTest.clearSharedOverlay();
    }
    @Test public void destroyFencesAudioAndClosesOwnedOverlayWithoutRecreatingIt() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        set(service, "active", service);
        set(service, "shown", true);
        KenanOverlayTest.Windows windows = new KenanOverlayTest.Windows();
        KenanOverlay overlay = new KenanOverlay(service, windows.manager());
        KenanOverlayTest.bindSharedOverlay(service, null, service, overlay);
        assertTrue(service.visible());

        service.onDestroy();

        assertTrue((boolean) get(service, "destroyed"));
        assertFalse(service.visible());
        assertFalse(service.busy());
        assertNull(get(service, "active"));
        assertTrue(overlay.closed());
        assertNull(SharedOverlay.current());
        assertNull(SharedOverlay.writer());
        assertTrue(windows.attached.isEmpty());
        int added = windows.adds;
        int removed = windows.removes;

        call(service, "completed", "late result");
        call(service, "failed", "late failure");
        service.onAccessibilityEvent(android.view.accessibility.AccessibilityEvent.obtain());
        service.onDestroy();
        SharedOverlay.refresh();

        assertFalse(service.visible());
        assertNull(SharedOverlay.current());
        assertEquals(added, windows.adds);
        assertEquals(removed, windows.removes);
    }
    @Test public void destroyingWriteLeavesPhoneOwnedOverlayRunning() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        set(service, "active", service);
        set(service, "shown", true);
        PhoneAccessibilityService phone = Robolectric.buildService(PhoneAccessibilityService.class).get();
        KenanOverlayTest.Windows windows = new KenanOverlayTest.Windows();
        KenanOverlay overlay = new KenanOverlay(phone, windows.manager());
        KenanOverlayTest.bindSharedOverlay(phone, phone, service, overlay);

        service.onDestroy();

        assertTrue((boolean) get(service, "destroyed"));
        assertFalse(service.visible());
        assertNull(SharedOverlay.writer());
        assertTrue(SharedOverlay.hasPhone());
        assertSame(overlay, SharedOverlay.current());
        assertFalse(overlay.closed());
        assertEquals(0, windows.removes);
        assertEquals(2, windows.attached.size());

        SharedOverlay.detach(phone);
        assertTrue(overlay.closed());
        assertNull(SharedOverlay.current());
        assertFalse(SharedOverlay.hasPhone());
        assertTrue(windows.attached.isEmpty());
    }
}
