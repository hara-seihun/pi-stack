package works.kenan.piremote.kenan;

/** Remembers a dismissed editor until focus leaves it, without storing its text. */
final class WriteFieldDismissal {
    record Field(Object node, int window, String viewId, int left, int top, int right, int bottom) {
        boolean same(Field other) {
            if (other == null || window != other.window) return false;
            if (node != null && other.node != null && node.equals(other.node)) return true;
            return viewId != null && viewId.equals(other.viewId) && left == other.left && top == other.top
                && right == other.right && bottom == other.bottom;
        }
    }

    private Field dismissed;
    private boolean left;

    void dismiss(Field field) { dismissed = field; left = false; }
    void clear() { dismissed = null; left = false; }
    boolean active() { return dismissed != null; }

    void focusLeft(Field other) {
        if (dismissed != null && (other == null || !dismissed.same(other))) left = true;
    }

    /** A new field is immediately eligible; a refocus of the dismissed field is eligible after focus left it. */
    boolean hides(Field focused, boolean focusedEvent) {
        if (dismissed == null) return false;
        if (focused == null) return true;
        if (!dismissed.same(focused) || left && focusedEvent) {
            clear();
            return false;
        }
        return true;
    }
}
