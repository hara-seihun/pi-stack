package dev.piremote;

import java.util.List;
import java.util.Locale;

final class PromptComposer {
    private PromptComposer() {}

    static String compose(String text, List<String> attachmentPaths) {
        String value = text == null ? "" : text.trim();
        if (attachmentPaths.isEmpty()) return value;
        StringBuilder result = new StringBuilder(value);
        if (result.length() > 0) result.append("\n\n");
        result.append("The following files were attached to this message:\n");
        for (String path : attachmentPaths) result.append("- ").append(path).append('\n');
        return result.toString().trim();
    }

    static String restoreDraft(String queuedText, String currentDraft) {
        String queued = queuedText == null ? "" : queuedText;
        String current = currentDraft == null ? "" : currentDraft;
        if (current.trim().isEmpty() || current.trim().equals(queued.trim())) return queued;
        return queued + "\n\n" + current;
    }

    /**
     * What the slash menu is allowed to offer. Every model reachable from here carries a pile
     * of MCP plumbing and provider commands that nobody types on a phone, so the menu shows the
     * skills and nothing else — including nothing named for MCP, which is what the clutter was.
     * Anything hidden here is still a real command and still runs when typed in full.
     */
    static boolean commandListed(String name, String source) {
        if (!"skill".equals(source)) return false;
        return !name.toLowerCase(Locale.ROOT).contains("mcp");
    }

    static boolean commandMatches(String name, String token) {
        String query = token.toLowerCase(Locale.ROOT);
        for (String segment : name.toLowerCase(Locale.ROOT).split(":")) {
            if (segment.startsWith(query)) return true;
        }
        return false;
    }

    static String commandLabel(String name, String description, String source) {
        String label = "/" + name;
        if ("skill".equals(source) || description.isEmpty()) return label;
        return label + "   " + description;
    }
}
