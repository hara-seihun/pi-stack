package dev.piremote;

import java.util.Locale;

/**
 * Presentation rules for read-only observation of the orchestrator's autonomous
 * agents. The list holds only working agents; an agent that settles while it is
 * open stays open and shows the terminal result the orchestrator recorded.
 */
final class AgentRunView {
    private AgentRunView() {}

    static String duration(long millis) {
        long seconds = Math.max(0, Math.round(millis / 1000.0));
        if (seconds < 60) return seconds + "s";
        long minutes = seconds / 60;
        if (minutes < 60) return minutes + "m";
        return (minutes / 60) + "h " + (minutes % 60) + "m";
    }

    static boolean running(String status) {
        return "running".equals(status);
    }

    static String statusLabel(String status, String activity) {
        if (!running(status)) return (status == null ? "" : status).toUpperCase(Locale.ROOT);
        String value = activity == null || activity.isEmpty() ? "WORKING" : activity;
        return "WAITING_ON_TOOL".equals(value) ? "WAITING ON TOOL" : value;
    }

    static String banner(String label, String taskId, String status, String provider, long elapsedMs) {
        String elapsed = duration(elapsedMs);
        String phase = running(status) ? "running " + elapsed : status + " after " + elapsed;
        return "Observing " + label + " on " + taskId + " · " + phase
            + (provider == null || provider.isEmpty() ? "" : " · " + provider) + " · read-only";
    }
}
