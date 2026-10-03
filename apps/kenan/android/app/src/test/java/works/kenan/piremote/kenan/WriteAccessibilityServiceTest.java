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
@Config(sdk = 28, application = android.app.Application.class,
    shadows = WriteAccessibilityServiceTest.FocusedNode.class)
public class WriteAccessibilityServiceTest {
    @org.robolectric.annotation.Implements(AccessibilityNodeInfo.class)
    public static class FocusedNode extends org.robolectric.shadows.ShadowAccessibilityNodeInfo {
        @org.robolectric.annotation.RealObject private AccessibilityNodeInfo node;
        @org.robolectric.annotation.Implementation protected AccessibilityNodeInfo findFocus(int focus) {
            return node.isFocused() ? node : null;
        }
    }
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
        shadowOf(node).setRefreshReturnValue(true);
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
    @Test public void vanishedFieldCopiesTranscriptInsteadOfOverwritingStaleHint() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        AccessibilityNodeInfo node = editable("Type a message", true);
        set(service, "target", node);
        set(service, "windowId", node.getWindowId());
        shadowOf(node).setRefreshReturnValue(false);
        call(service, "completed", "Keep this transcript");
        assertTrue((boolean) get(service, "clipboardReady"));
        assertTrue(shadowOf(node).getPerformedActions().isEmpty());
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
        android.content.Context context = org.robolectric.RuntimeEnvironment.getApplication();
        context.getSharedPreferences("write-settings", 0).edit().clear().commit();
        NotificationIdentity.get(context).replace("", "");
    }
    private WriteAccessibilityService focusedService(boolean keyboard) throws Exception {
        WriteAccessibilityService service = Robolectric.buildService(WriteAccessibilityService.class).get();
        set(service, "active", service);
        NotificationIdentity.get(service).replace("hara", "test-session");
        shadowOf(org.robolectric.RuntimeEnvironment.getApplication()).grantPermissions(android.Manifest.permission.RECORD_AUDIO);
        org.robolectric.shadows.ShadowSettings.setCanDrawOverlays(true);
        AccessibilityNodeInfo node = editable("Existing text", false);
        android.view.accessibility.AccessibilityWindowInfo application = android.view.accessibility.AccessibilityWindowInfo.obtain();
        shadowOf(application).setType(android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION);
        shadowOf(application).setRoot(node);
        java.util.List<android.view.accessibility.AccessibilityWindowInfo> windows = new ArrayList<>();
        windows.add(application);
        if (keyboard) {
            android.view.accessibility.AccessibilityWindowInfo input = android.view.accessibility.AccessibilityWindowInfo.obtain();
            shadowOf(input).setType(android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD);
            windows.add(input);
        }
        shadowOf(service).setWindows(windows);
        KenanOverlayTest.Windows overlayWindows = new KenanOverlayTest.Windows();
        KenanOverlay overlay = new KenanOverlay(service, overlayWindows.manager());
        KenanOverlayTest.bindSharedOverlay(service, null, service, overlay);
        return service;
    }
    private void enabled(WriteAccessibilityService service, boolean enabled) {
        service.getSharedPreferences("write-settings", 0).edit().putBoolean("overlayEnabled", enabled).commit();
        WriteAccessibilityService.settingsChanged();
        shadowOf(android.os.Looper.getMainLooper()).idle();
    }
    @Test public void disablingFencesConnectingRecordingAndFinishingWithoutClosingPhoneOverlay() throws Exception {
        for (String phase : new String[] { "connecting", "recording", "finishing" }) {
            WriteAccessibilityService service = focusedService(true);
            WriteAccessibilityService.settingsChanged();
            shadowOf(android.os.Looper.getMainLooper()).idle();
            assertTrue(service.visible());
            set(service, phase, true);
            set(service, "generation", 42L);
            WriteConnection connection = new WriteConnection(service, NotificationIdentity.get(service).current(),
                new WriteConnection.Events() {
                    public void connected() {} public void partial(String text) {}
                    public void finished(String text) {} public void failed(String message) {}
                });
            set(service, "connection", connection);
            WriteOpusRecorder recorder = new WriteOpusRecorder(new WriteOpusRecorder.Listener() {
                public void packet(byte[] packet) {} public void amplitude(int level) {}
                public void stopped() {} public void failed(String message) {}
            });
            boolean[] inputStopped = { false };
            org.robolectric.util.ReflectionHelpers.setField(recorder, "activeInput", new WriteOpusRecorder.Input() {
                public void start() {} public int read(byte[] frame, int offset, int length) { return 0; }
                public void stop() { inputStopped[0] = true; } public void close() {}
            });
            set(service, "recorder", recorder);
            ((ArrayList<byte[]>) get(service, "packets")).add(new byte[] { 1, 2 });
            PhoneAccessibilityService phone = Robolectric.buildService(PhoneAccessibilityService.class).get();
            KenanOverlay overlay = SharedOverlay.current();
            KenanOverlayTest.bindSharedOverlay(service, phone, service, overlay);

            enabled(service, false);

            assertFalse(phase, service.visible());
            assertFalse(phase, service.busy());
            assertTrue((long) get(service, "generation") > 42);
            assertNull(get(service, "connection"));
            assertNull(get(service, "recorder"));
            assertTrue((boolean) org.robolectric.util.ReflectionHelpers.getField(connection, "closed"));
            assertFalse((boolean) org.robolectric.util.ReflectionHelpers.getField(recorder, "running"));
            assertTrue("microphone input stopped immediately", inputStopped[0]);
            assertTrue(((ArrayList<?>) get(service, "packets")).isEmpty());
            assertNull(get(service, "target"));
            assertTrue(SharedOverlay.hasPhone());
            assertSame(overlay, SharedOverlay.current());
            assertFalse(overlay.closed());
            call(service, "completed", "late transcript");
            assertFalse((boolean) get(service, "clipboardReady"));
            service.onAccessibilityEvent(android.view.accessibility.AccessibilityEvent.obtain());
            assertFalse(service.visible());
            enabled(service, true);
            assertTrue("enabling refreshes without an accessibility event", service.visible());
            KenanOverlayTest.clearSharedOverlay();
        }
    }
    @Test public void disabledPreferenceSurvivesServiceRestartAndBlocksTaps() throws Exception {
        WriteAccessibilityService first = focusedService(true);
        enabled(first, false);
        first.onDestroy();
        WriteAccessibilityService restarted = focusedService(true);
        restarted.onServiceConnected();
        assertFalse(restarted.visible());
        restarted.onAccessibilityEvent(android.view.accessibility.AccessibilityEvent.obtain());
        restarted.tapped();
        assertFalse(restarted.visible());
        assertFalse(restarted.busy());
        enabled(restarted, true);
        assertTrue(restarted.visible());
    }
    @Test public void keyboardPreferenceRefreshesWithoutWaitingForAccessibilityEvents() throws Exception {
        WriteAccessibilityService service = focusedService(false);
        WriteAccessibilityService.settingsChanged();
        shadowOf(android.os.Looper.getMainLooper()).idle();
        assertFalse(service.visible());
        service.getSharedPreferences("write-settings", 0).edit().putBoolean("keyboardRequired", false).commit();
        WriteAccessibilityService.settingsChanged();
        shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(service.visible());
        service.getSharedPreferences("write-settings", 0).edit().putBoolean("keyboardRequired", true).commit();
        WriteAccessibilityService.settingsChanged();
        shadowOf(android.os.Looper.getMainLooper()).idle();
        assertFalse(service.visible());
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
