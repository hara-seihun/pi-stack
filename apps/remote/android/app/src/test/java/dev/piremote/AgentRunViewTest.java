package dev.piremote;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AgentRunViewTest {
    @Test public void elapsedTimeStaysReadableAcrossScales() {
        assertEquals("0s", AgentRunView.duration(0));
        assertEquals("45s", AgentRunView.duration(45_000));
        assertEquals("2m", AgentRunView.duration(150_000));
        assertEquals("1h 30m", AgentRunView.duration(5_400_000));
    }

    @Test public void aRunningAgentShowsActivityAndAFinishedOneItsResult() {
        assertEquals("WORKING", AgentRunView.statusLabel("running", ""));
        assertEquals("THINKING", AgentRunView.statusLabel("running", "THINKING"));
        assertEquals("WAITING ON TOOL", AgentRunView.statusLabel("running", "WAITING_ON_TOOL"));
        assertEquals("INCOMPLETE", AgentRunView.statusLabel("incomplete", "WORKING"));
        assertEquals("INTERRUPTED", AgentRunView.statusLabel("interrupted", null));
    }

    @Test public void theBannerStatesTheObservationIsReadOnly() {
        assertEquals("Observing SOL on research-frontier · running 2m · openai-codex-3 · read-only",
            AgentRunView.banner("SOL", "research-frontier", "running", "openai-codex-3", 120_000));
        assertEquals("Observing OPUS on research-admission · complete after 45s · read-only",
            AgentRunView.banner("OPUS", "research-admission", "complete", "", 45_000));
    }
}
