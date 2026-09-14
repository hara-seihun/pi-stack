package works.kenan.piremote.kenan;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteSessionTest {
    @Test public void changingPersonOrSessionInvalidatesInflightResponses() {
        RemoteSession state = new RemoteSession();
        assertNull(state.current());
        assertTrue(state.replace("one", "token-a"));
        var first = state.current();
        assertFalse(state.replace("one", "token-a"));
        assertTrue(state.isCurrent(first));
        assertTrue(state.replace("two", "token-b"));
        assertFalse(state.isCurrent(first));
        var second = state.current();
        assertTrue(state.replace("two", "token-c"));
        assertFalse(state.isCurrent(second));
        var rotated = state.current();
        assertTrue(state.replace("", ""));
        assertFalse(state.isCurrent(rotated));
        assertNull(state.current());
        state.replace("one", "token-a");
        assertFalse(state.isCurrent(first));
    }

    @Test public void personHintAloneCannotCreateIdentity() {
        RemoteSession state = new RemoteSession();
        assertThrows(IllegalArgumentException.class, () -> state.replace("one", ""));
        assertThrows(IllegalArgumentException.class, () -> state.replace("", "token"));
        assertThrows(IllegalArgumentException.class, () -> state.replace("one", "token\r\nother"));
        assertNull(state.current());
    }
}
