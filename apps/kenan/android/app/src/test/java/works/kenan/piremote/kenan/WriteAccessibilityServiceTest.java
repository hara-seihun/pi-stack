package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
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
    private void windowCall(WriteAccessibilityService service, String method) throws Exception {
        Method call = WriteAccessibilityService.class.getDeclaredMethod(method);
        call.setAccessible(true);
        call.invoke(service);
    }
    private void windows(WriteAccessibilityService service, String failedOperation) throws Exception {
        set(service, "windows", java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class<?>[]{android.view.WindowManager.class}, (proxy, method, args) -> {
                if (method.getName().equals(failedOperation)) {
                    if (failedOperation.equals("addView")) throw new android.view.WindowManager.BadTokenException("Service token expired");
                    throw new IllegalArgumentException("Window was detached");
                }
                return null;
            }));
    }
    @Test public void expiredWindowTokenDoesNotCrashApplication() throws Exception {
        WriteAccessibilityService service = Robolectric.buildService(WriteAccessibilityService.class).get();
        windows(service, "addView");
        windowCall(service, "show");
        windowCall(service, "showDismissTarget");
        assertNull(get(service, "bubble"));
        assertNull(get(service, "dismissTarget"));
    }
    @Test public void detachedWindowUpdateRemovesOverlayInsteadOfCrashing() throws Exception {
        WriteAccessibilityService service = Robolectric.buildService(WriteAccessibilityService.class).get();
        windows(service, "updateViewLayout");
        windowCall(service, "show");
        assertNotNull(get(service, "bubble"));
        Method move = WriteAccessibilityService.class.getDeclaredMethod("move", int.class, int.class);
        move.setAccessible(true);
        move.invoke(service, 10, 10);
        assertNull(get(service, "bubble"));
    }
    @Test public void destroyDoesNotRecreateOverlay() throws Exception {
        WriteAccessibilityService service = withActiveSender();
        service.onDestroy();
        assertTrue((boolean) get(service, "destroyed"));
        assertNull(get(service, "bubble"));
    }
}
