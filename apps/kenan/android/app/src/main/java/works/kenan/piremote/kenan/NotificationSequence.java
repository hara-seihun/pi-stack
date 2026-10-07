package works.kenan.piremote.kenan;

import java.util.HashSet;
import java.util.Set;

/** Partial stream events may lead the cursor; only complete ordered replay closes the gap. */
final class NotificationSequence {
    private long cursor;
    private final Set<Long> streamed;

    NotificationSequence(long cursor, Set<Long> streamed) {
        this.cursor = cursor;
        this.streamed = new HashSet<>(streamed);
    }

    static boolean canReplay(long cursor, Long after, long feedCursor) {
        return after == null ? cursor < 0 || feedCursor <= cursor : after >= 0 && after <= cursor;
    }

    boolean accept(long seq, long feedCursor, boolean stream) {
        if (seq < 0 || seq > feedCursor) throw new IllegalArgumentException("Invalid notification sequence");
        if (seq <= cursor || streamed.contains(seq)) return false;
        if (stream) streamed.add(seq);
        return true;
    }

    void settle(long feedCursor, boolean stream) {
        if (feedCursor < 0) throw new IllegalArgumentException("Invalid notification cursor");
        if (!stream) cursor = Math.max(cursor, feedCursor);
        streamed.removeIf(seq -> seq <= cursor);
    }

    long cursor() { return cursor; }
    Set<Long> streamed() { return Set.copyOf(streamed); }
}
