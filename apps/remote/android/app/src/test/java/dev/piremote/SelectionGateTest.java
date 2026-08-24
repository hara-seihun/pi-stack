package dev.piremote;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SelectionGateTest {
    @Test public void appliesTheAnswerToTheThreadThatAskedForIt() {
        assertTrue(SelectionGate.transcriptApplies(7, 7, "thread-a", "thread-a", false));
    }

    @Test public void refusesATranscriptAfterANotificationOpenedAnotherThread() {
        // The poll left while thread-a was open; opening thread-b from a notification bumped
        // the generation. Applying it would append a's tail to b and skip past b's history.
        assertFalse(SelectionGate.transcriptApplies(7, 8, "thread-a", "thread-b", false));
    }

    @Test public void refusesATranscriptWhenTheSelectionMovedWithoutAGenerationChange() {
        assertFalse(SelectionGate.transcriptApplies(7, 7, "thread-a", "thread-b", false));
    }

    @Test public void refusesATranscriptWhileObservingAnOrchestratorRun() {
        assertFalse(SelectionGate.transcriptApplies(7, 7, "thread-a", "thread-a", true));
    }

    @Test public void refusesATranscriptWhenNothingIsSelected() {
        assertFalse(SelectionGate.transcriptApplies(7, 7, null, null, false));
    }

    @Test public void appliesASnapshotOnlyWhenNoLocalChangeIsOutstanding() {
        assertTrue(SelectionGate.snapshotApplies(3, 3, false));
        assertFalse(SelectionGate.snapshotApplies(3, 4, false));
        assertFalse(SelectionGate.snapshotApplies(3, 3, true));
    }
}
