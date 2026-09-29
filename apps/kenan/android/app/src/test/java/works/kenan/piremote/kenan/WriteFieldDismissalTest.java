package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Test;

public final class WriteFieldDismissalTest {
    private static WriteFieldDismissal.Field field(Object node, int window, String id, int y) {
        return new WriteFieldDismissal.Field(node, window, id, 20, y, 320, y + 60);
    }

    @Test public void staysHiddenOnSameFieldAndTransientNullFocus() {
        WriteFieldDismissal dismissal = new WriteFieldDismissal();
        Object node = new Object();
        dismissal.dismiss(field(node, 1, "message", 100));
        assertTrue(dismissal.hides(field(node, 1, "message", 100), false));
        assertTrue(dismissal.hides(null, false));
        assertTrue(dismissal.hides(field(new Object(), 1, "message", 100), false));
        assertTrue(dismissal.active());
    }

    @Test public void nextTextBoxShowsEvenWithSameViewId() {
        WriteFieldDismissal dismissal = new WriteFieldDismissal();
        dismissal.dismiss(field(new Object(), 1, "message", 100));
        assertFalse(dismissal.hides(field(new Object(), 1, "message", 200), true));
        assertFalse(dismissal.active());
    }

    @Test public void leavingAndRefocusingSameFieldShows() {
        WriteFieldDismissal dismissal = new WriteFieldDismissal();
        Object node = new Object();
        dismissal.dismiss(field(node, 1, "message", 100));
        dismissal.focusLeft(field(new Object(), 1, "button", 300));
        assertTrue(dismissal.hides(field(node, 1, "message", 100), false));
        assertFalse(dismissal.hides(field(node, 1, "message", 100), true));
    }

    @Test public void differentWindowShowsAndRecreatedSameNodeUsesViewId() {
        WriteFieldDismissal dismissal = new WriteFieldDismissal();
        dismissal.dismiss(field(new Object(), 1, "message", 100));
        assertTrue(dismissal.hides(field(new Object(), 1, "message", 100), true));
        assertFalse(dismissal.hides(field(new Object(), 2, "message", 100), true));
    }
}
