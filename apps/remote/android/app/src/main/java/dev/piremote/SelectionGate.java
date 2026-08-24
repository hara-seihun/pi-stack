package dev.piremote;

/**
 * Whether a poll's answer still describes what the screen is showing.
 *
 * A poll asks about the thread selected at the moment it left, and carries that thread's event
 * cursor with it. By the time it returns the selection may have moved, and the sharpest case is
 * a notification: tapping one opens its thread from inside the drawer render, in the same frame
 * that a poll launched for the previous thread is being applied. Applying that answer anyway
 * writes one thread's transcript into another's and, worse, advances the shared event cursor
 * past the opened thread's own history, so the thread the notification promised never loads at
 * all until it is left and re-entered.
 *
 * The questions here are therefore asked of the selection as it stands at the instant of
 * application, never of the one that stood when the response was parsed.
 */
final class SelectionGate {
    private SelectionGate() {}

    /** True when the transcript in hand belongs to the thread now on screen. */
    static boolean transcriptApplies(long requestedGeneration, long currentGeneration,
                                     String requestedSession, String currentSession,
                                     boolean observingAgent) {
        return requestedGeneration == currentGeneration
            && !observingAgent
            && requestedSession != null
            && requestedSession.equals(currentSession);
    }

    /** True when no local change is outstanding that the polled snapshot would undo. */
    static boolean snapshotApplies(long requestedActionGeneration, long currentActionGeneration,
                                   boolean actionInFlight) {
        return requestedActionGeneration == currentActionGeneration && !actionInFlight;
    }
}
