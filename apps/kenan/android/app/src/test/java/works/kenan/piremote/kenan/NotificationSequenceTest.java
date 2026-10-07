package works.kenan.piremote.kenan;

import org.junit.Test;
import java.util.Set;
import static org.junit.Assert.*;

public final class NotificationSequenceTest {
    @Test public void replayCannotSkipNativeCursorOrRaceItsInitialBaseline() {
        assertTrue(NotificationSequence.canReplay(-1, null, 20));
        assertFalse(NotificationSequence.canReplay(-1, 0L, 20));
        assertFalse(NotificationSequence.canReplay(10, null, 20));
        assertTrue(NotificationSequence.canReplay(10, null, 10));
        assertTrue(NotificationSequence.canReplay(10, 5L, 20));
        assertFalse(NotificationSequence.canReplay(10, 11L, 20));
        assertFalse(NotificationSequence.canReplay(10, -1L, 20));
    }

    @Test public void streamAheadOfPollDoesNotSkipMissingCompletionsOrDeliverTwice() {
        NotificationSequence sequence = new NotificationSequence(10, Set.of());
        assertTrue(sequence.accept(15, 15, true));
        sequence.settle(15, true);
        assertEquals(10, sequence.cursor());
        assertFalse(sequence.accept(15, 15, false));
        assertTrue(sequence.accept(12, 15, false));
        sequence.settle(15, false);
        assertEquals(15, sequence.cursor());
        assertTrue(sequence.streamed().isEmpty());
        assertFalse(sequence.accept(15, 15, true));
    }

    @Test public void streamReceiptsSurviveRestartUntilPollCatchesUp() {
        NotificationSequence first = new NotificationSequence(-1, Set.of());
        assertTrue(first.accept(3, 5, true));
        first.settle(5, true);
        NotificationSequence restarted = new NotificationSequence(first.cursor(), first.streamed());
        assertFalse(restarted.accept(3, 5, false));
        restarted.settle(5, false);
        assertTrue(restarted.streamed().isEmpty());
    }
}
