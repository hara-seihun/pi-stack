package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.database.Cursor;
import android.view.MotionEvent;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public final class NativeStateTest {
    @Test public void allWireDomainsRejectUndescribedValuesInsteadOfSelectingAnotherState() {
        for (Class<?> domain : NativeState.class.getDeclaredClasses()) {
            if (domain.isEnum() && NativeState.Value.class.isAssignableFrom(domain)) checkDomain(domain);
        }
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static void checkDomain(Class domain) {
        Set<String> wires = new HashSet<>();
        for (Object constant : domain.getEnumConstants()) {
            String wire = ((NativeState.Value) constant).wire();
            assertTrue("Repeated wire value in " + domain, wires.add(wire));
            assertEquals(constant, NativeState.require(domain, wire));
        }
        for (String invalid : new String[] { null, "", "future-undescribed-state", " ready " }) {
            assertFalse(NativeState.parse(domain, invalid).isPresent());
            assertThrows(IllegalArgumentException.class, () -> NativeState.require(domain, invalid));
        }
    }

    @Test public void platformDiscriminantsDoNotTreatUnknownNumbersAsTextOrTouches() {
        assertEquals(NativeState.CursorType.STRING, NativeState.CursorType.require(Cursor.FIELD_TYPE_STRING));
        assertEquals(NativeState.Touch.CANCEL, NativeState.Touch.require(MotionEvent.ACTION_CANCEL));
        assertEquals(NativeState.Touch.POINTER_DOWN, NativeState.Touch.require(MotionEvent.ACTION_POINTER_DOWN));
        assertThrows(IllegalArgumentException.class, () -> NativeState.CursorType.require(999));
        assertThrows(IllegalArgumentException.class, () -> NativeState.Touch.require(999));
    }

    @Test public void finishBeforeConnectionCannotResumeRecordingWhenTheSocketOpens() {
        NativeState.WritePhase finishing = NativeState.WritePhase.BUFFERING.finish();
        assertEquals(NativeState.WritePhase.FINISHING_CONNECTING, finishing);
        assertTrue(finishing.busy());
        assertTrue(finishing.connecting);
        assertFalse(finishing.recording);
        assertEquals(NativeState.WritePhase.FINISHING, finishing.connected());
        assertEquals(NativeState.WritePhase.RECORDING, NativeState.WritePhase.BUFFERING.connected());
        assertEquals(NativeState.WritePhase.FINISHING, NativeState.WritePhase.RECORDING.finish());
        assertThrows(IllegalStateException.class, () -> NativeState.WritePhase.IDLE.finish());
    }

    @Test public void phoneReadyIsAnAcknowledgementNotAnUnknownCommand() {
        assertEquals(NativeState.PhoneFrame.READY, NativeState.require(NativeState.PhoneFrame.class, "ready"));
        assertFalse(NativeState.parse(NativeState.PhoneFrame.class, "result").isPresent());
    }
}
