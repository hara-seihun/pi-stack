package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Test;

public final class OverlayPolicyTest {
    private static final class Dot {
        boolean kenan = true, busy;
        final WriteFieldDismissal mic = new WriteFieldDismissal();
        WriteFieldDismissal.Field field = field("first");
        static WriteFieldDismissal.Field field(String id) {
            return new WriteFieldDismissal.Field(new Object(), 1, id, 0, 0, 200, 60);
        }
        boolean microphone() { return !mic.hides(field, false); }
        OverlayPolicy.Mode mode() { return OverlayPolicy.mode(kenan, microphone()); }
        void dismiss(OverlayPolicy.Dismissal target) {
            OverlayPolicy.dismiss(target, kenan, microphone(), busy, () -> kenan = false, () -> mic.dismiss(field));
        }
    }

    @Test public void focusingAnEditorChangesTheOneDotAndBlurRestoresKenan() {
        assertEquals(OverlayPolicy.Mode.KENAN, OverlayPolicy.mode(true, false));
        assertEquals(OverlayPolicy.Mode.MIC, OverlayPolicy.mode(true, true));
        assertEquals(OverlayPolicy.Mode.KENAN, OverlayPolicy.mode(true, false));
        assertEquals(OverlayPolicy.Mode.MIC, OverlayPolicy.mode(false, true));
        assertEquals(OverlayPolicy.Mode.HIDDEN, OverlayPolicy.mode(false, false));
    }

    @Test public void dismissingKenanKeepsMicAndDoesNotReturnOnBlur() {
        Dot dot = new Dot();
        dot.dismiss(OverlayPolicy.Dismissal.KENAN);
        assertEquals(OverlayPolicy.Mode.MIC, dot.mode());
        assertEquals(OverlayPolicy.Mode.HIDDEN, OverlayPolicy.mode(dot.kenan, false));
        dot.field = Dot.field("next");
        assertEquals(OverlayPolicy.Mode.MIC, dot.mode());
    }

    @Test public void dismissingMicRestoresKenanUntilAnotherEditor() {
        Dot dot = new Dot();
        dot.dismiss(OverlayPolicy.Dismissal.MIC);
        assertEquals(OverlayPolicy.Mode.KENAN, dot.mode());
        assertEquals(OverlayPolicy.Mode.KENAN, dot.mode());
        dot.field = Dot.field("next");
        assertEquals(OverlayPolicy.Mode.MIC, dot.mode());
    }

    @Test public void bothHidesBothWithoutTurningOffDictationForFutureFields() {
        Dot dot = new Dot();
        dot.dismiss(OverlayPolicy.Dismissal.BOTH);
        assertEquals(OverlayPolicy.Mode.HIDDEN, dot.mode());
        assertEquals(OverlayPolicy.Mode.HIDDEN, dot.mode());
        dot.field = Dot.field("next");
        assertEquals(OverlayPolicy.Mode.MIC, dot.mode());
        assertFalse(dot.kenan);
    }

    @Test public void busyDictationCannotBeHiddenByMicOrBothButKenanCan() {
        Dot dot = new Dot(); dot.busy = true;
        dot.dismiss(OverlayPolicy.Dismissal.MIC);
        dot.dismiss(OverlayPolicy.Dismissal.BOTH);
        assertTrue(dot.kenan);
        assertEquals(OverlayPolicy.Mode.MIC, dot.mode());
        dot.dismiss(OverlayPolicy.Dismissal.KENAN);
        assertFalse(dot.kenan);
        assertEquals(OverlayPolicy.Mode.MIC, dot.mode());
    }

    @Test public void eitherServiceCanDismissItsDotWithoutTheOther() {
        boolean[] hidden = { false, false };
        OverlayPolicy.dismiss(OverlayPolicy.Dismissal.BOTH, true, false, false, () -> hidden[0] = true, () -> hidden[1] = true);
        assertTrue(hidden[0]); assertFalse(hidden[1]);
        hidden[0] = false;
        OverlayPolicy.dismiss(OverlayPolicy.Dismissal.BOTH, false, true, false, () -> hidden[0] = true, () -> hidden[1] = true);
        assertFalse(hidden[0]); assertTrue(hidden[1]);
    }
}
