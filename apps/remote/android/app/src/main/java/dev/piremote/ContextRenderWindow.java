package dev.piremote;

import java.util.List;

/** Selects a stable tail window while pinned context sections remain visible. */
final class ContextRenderWindow {
    static final class Selection {
        final int start;
        final int hidden;

        Selection(int start, int hidden) {
            this.start = start;
            this.hidden = hidden;
        }
    }

    private final int initialSize;
    private final int pageSize;
    private final int maximumAutomaticSize;
    private String anchorKey;
    private boolean initialized;
    private boolean expanded;

    ContextRenderWindow(int initialSize, int pageSize, int maximumAutomaticSize) {
        if (initialSize <= 0 || pageSize <= 0 || maximumAutomaticSize < initialSize)
            throw new IllegalArgumentException("Context window sizes are inconsistent");
        this.initialSize = initialSize;
        this.pageSize = pageSize;
        this.maximumAutomaticSize = maximumAutomaticSize;
    }

    Selection select(List<String> keys, int pinned) {
        int boundary = Math.max(0, Math.min(pinned, keys.size()));
        int start = initialized ? indexOf(keys, anchorKey, boundary) : -1;
        if (start < boundary) start = Math.max(boundary, keys.size() - initialSize);
        if (!expanded && keys.size() - start > maximumAutomaticSize)
            start = Math.max(boundary, keys.size() - maximumAutomaticSize);
        initialized = true;
        anchorKey = start < keys.size() ? keys.get(start) : null;
        return new Selection(start, start - boundary);
    }

    Selection expand(List<String> keys, int pinned) {
        Selection current = select(keys, pinned);
        int start = Math.max(Math.max(0, Math.min(pinned, keys.size())), current.start - pageSize);
        expanded = true;
        anchorKey = start < keys.size() ? keys.get(start) : null;
        return new Selection(start, start - Math.max(0, Math.min(pinned, keys.size())));
    }

    void reset() {
        initialized = false;
        expanded = false;
        anchorKey = null;
    }

    private static int indexOf(List<String> keys, String key, int start) {
        if (key == null) return -1;
        for (int index = start; index < keys.size(); index++) if (key.equals(keys.get(index))) return index;
        return -1;
    }
}
