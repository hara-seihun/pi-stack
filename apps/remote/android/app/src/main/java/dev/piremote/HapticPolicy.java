package dev.piremote;

/**
 * Timing and intensity arithmetic for continuous haptic texture. Kept apart from the
 * Android vibrator so the rules that stop texture from turning into a buzz can be tested.
 */
final class HapticPolicy {
    /** Two primitives closer than this are felt as one, so texture below it is wasted energy. */
    static final int TEXTURE_GAP_MS = 32;
    /** Texture stays quiet this long after a meaningful effect so the meaning survives. */
    static final int STATEMENT_MUTE_MS = 140;
    /**
     * The vibrator plays one effect at a time, so a second meaningful effect would erase the
     * first. They are spaced out instead of cancelling, and abandoned once the backlog would
     * arrive too late to mean anything.
     */
    static final int STATEMENT_SPACING_MS = 130;
    static final int MAX_STATEMENT_QUEUE_MS = 420;
    static final int MAX_SCROLL_TICKS = 4;

    private HapticPolicy() {}

    static int scrollTicks(float travelPixels, float pixelsPerTick) {
        if (travelPixels <= 0 || pixelsPerTick <= 0) return 0;
        return Math.min(MAX_SCROLL_TICKS, (int) (travelPixels / pixelsPerTick));
    }

    /** A swipe that is nearly committed should feel heavier than one just started. */
    static float dragScale(float progress) {
        float bounded = clamp(progress, 0f, 1f);
        return 0.14f + 0.86f * bounded * bounded;
    }

    /** The same swipe also gets denser, which is what makes the threshold feel like resistance. */
    static int dragIntervalMs(float progress) {
        float bounded = clamp(progress, 0f, 1f);
        return Math.round(120f - 88f * bounded);
    }

    static boolean elapsed(long nowMs, long lastMs, int gapMs) {
        return nowMs - lastMs >= gapMs;
    }

    static float clamp(float value, float low, float high) {
        return value < low ? low : value > high ? high : value;
    }
}
