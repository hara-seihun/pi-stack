package works.kenan.piremote.kenan;

/** Pixel geometry shared by touch handling, edge snapping and saved positions. */
final class WriteBubblePosition {
    record Bounds(int left, int top, int right, int bottom) {
        int width() { return right - left; }
        int height() { return bottom - top; }
    }
    record Point(int x, int y) {}

    static Point clamp(int x, int y, Bounds available, int diameter) {
        return new Point(Math.max(available.left, Math.min(x, available.right - diameter)),
            Math.max(available.top, Math.min(y, available.bottom - diameter)));
    }

    static boolean dragged(float downX, float downY, float x, float y, int slop) {
        float dx = x - downX, dy = y - downY;
        return dx * dx + dy * dy > slop * slop;
    }

    static Point snap(int x, int y, Bounds available, int diameter, float velocityX) {
        Point clamped = clamp(x, y, available, diameter);
        int middle = available.left + available.width() / 2;
        int side = Math.abs(velocityX) > 900 ? (velocityX < 0 ? available.left : available.right - diameter)
            : (clamped.x + diameter / 2 < middle ? available.left : available.right - diameter);
        return new Point(side, clamped.y);
    }

    static boolean nearDismiss(Point bubble, int bubbleSize, Point target, int targetSize, int radius) {
        int dx = bubble.x + bubbleSize / 2 - target.x - targetSize / 2;
        int dy = bubble.y + bubbleSize / 2 - target.y - targetSize / 2;
        return dx * dx + dy * dy <= radius * radius;
    }

    static Point magnet(Point bubble, Point target, int bubbleSize, int targetSize) {
        return new Point(Math.round(bubble.x * .35f + (target.x + (targetSize - bubbleSize) / 2f) * .65f),
            Math.round(bubble.y * .35f + (target.y + (targetSize - bubbleSize) / 2f) * .65f));
    }

    static int restoreY(float fraction, Bounds available, int diameter) {
        return available.top + Math.round(Math.max(0, Math.min(1, fraction)) * Math.max(0, available.height() - diameter));
    }
    static float saveY(int y, Bounds available, int diameter) {
        return (float) (y - available.top) / Math.max(1, available.height() - diameter);
    }
}
