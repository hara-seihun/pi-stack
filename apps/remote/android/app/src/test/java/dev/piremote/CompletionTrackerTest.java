package dev.piremote;

import org.junit.Test;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import static org.junit.Assert.*;

public class CompletionTrackerTest {
    @Test public void activeThreadRemainsWatchedUntilIdle() {
        CompletionTracker tracker = new CompletionTracker();
        tracker.watch("one", "First thread");

        assertTrue(tracker.update(Collections.singletonList(
            new CompletionTracker.Snapshot("one", "Renamed thread", "RUNNING"))).isEmpty());
        assertEquals(1, tracker.size());

        assertTrue(tracker.updateEnvironment(null, Collections.singletonList(
            new CompletionTracker.Snapshot("one", "Renamed thread", "IDLE", "The final answer")), 100).isEmpty());
        assertTrue(tracker.completeDue(1_099).isEmpty());

        List<CompletionTracker.Completion> completed = tracker.completeDue(1_100);
        assertEquals(1, completed.size());
        assertEquals("Renamed thread", completed.get(0).name);
        assertEquals("IDLE", completed.get(0).state);
        assertEquals("The final answer", completed.get(0).lastAssistantText);
        assertTrue(tracker.isEmpty());
    }

    @Test public void queuedAndAbortingStatesAreStillActive() {
        CompletionTracker tracker = new CompletionTracker();
        tracker.watch("one", "One"); tracker.watch("two", "Two");

        assertTrue(tracker.update(Arrays.asList(
            new CompletionTracker.Snapshot("one", "One", "RUNNING"),
            new CompletionTracker.Snapshot("two", "Two", "ABORTING"))).isEmpty());
        assertEquals(2, tracker.size());
    }

    @Test public void failureAndStopProduceTerminalResults() {
        CompletionTracker tracker = new CompletionTracker();
        tracker.watch("failed", "Failed"); tracker.watch("stopped", "Stopped");

        List<CompletionTracker.Completion> completed = tracker.update(Arrays.asList(
            new CompletionTracker.Snapshot("failed", "Failed", "FAILED"),
            new CompletionTracker.Snapshot("stopped", "Stopped", "STOPPED")));
        assertEquals(2, completed.size());
        assertEquals("FAILED", completed.get(0).state);
        assertEquals("STOPPED", completed.get(1).state);
    }

    @Test public void identicalSessionIdsRemainIndependentAcrossEnvironments() {
        CompletionTracker tracker = new CompletionTracker();
        tracker.watch("local", "same", "Local thread");
        tracker.watch("converge", "same", "Converge thread");

        assertTrue(tracker.updateEnvironment(null, Arrays.asList(
            new CompletionTracker.Snapshot("local", "same", "Local thread", "RUNNING", null),
            new CompletionTracker.Snapshot("converge", "same", "Converge thread", "IDLE", "Done")), 50).isEmpty());

        List<CompletionTracker.Completion> completed = tracker.completeDue(1_050);
        assertEquals(1, completed.size());
        assertEquals("converge", completed.get(0).environmentId);
        assertEquals(1, tracker.size());
    }

    @Test public void compactionCancelsTheTransientIdleCompletion() {
        CompletionTracker tracker = new CompletionTracker();
        tracker.watch("one", "One");

        assertTrue(tracker.updateEnvironment(null, Collections.singletonList(
            new CompletionTracker.Snapshot("one", "One", "IDLE", "Interrupted answer")), 100).isEmpty());
        assertEquals(1_100, tracker.nextCompletionAt());
        assertTrue(tracker.updateEnvironment(null, Collections.singletonList(
            new CompletionTracker.Snapshot("local", "one", "One", "IDLE", "COMPACTING", "Interrupted answer")), 200).isEmpty());
        assertEquals(Long.MAX_VALUE, tracker.nextCompletionAt());
        assertTrue(tracker.completeDue(2_000).isEmpty());
        assertEquals(1, tracker.size());

        assertTrue(tracker.updateEnvironment(null, Collections.singletonList(
            new CompletionTracker.Snapshot("one", "One", "RUNNING")), 2_100).isEmpty());
        assertTrue(tracker.updateEnvironment(null, Collections.singletonList(
            new CompletionTracker.Snapshot("one", "One", "IDLE", "Actual final answer")), 3_000).isEmpty());
        List<CompletionTracker.Completion> completed = tracker.completeDue(4_000);
        assertEquals(1, completed.size());
        assertEquals("Actual final answer", completed.get(0).lastAssistantText);
    }

    @Test public void deletedThreadIsForgottenWithoutCompletion() {
        CompletionTracker tracker = new CompletionTracker();
        tracker.watch("gone", "Gone");
        assertTrue(tracker.update(Collections.emptyList()).isEmpty());
        assertTrue(tracker.isEmpty());
    }
}
