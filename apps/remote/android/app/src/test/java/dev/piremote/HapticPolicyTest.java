package dev.piremote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HapticPolicyTest {
    @Test public void scrollTicksCountDistanceTravelledAndCapPerFrame() {
        assertEquals(0, HapticPolicy.scrollTicks(30, 56));
        assertEquals(2, HapticPolicy.scrollTicks(120, 56));
        assertEquals(HapticPolicy.MAX_SCROLL_TICKS, HapticPolicy.scrollTicks(9_000, 56));
        assertEquals(0, HapticPolicy.scrollTicks(120, 0));
    }

    @Test public void aSwipeGetsHeavierAndDenserTowardsItsThreshold() {
        assertTrue(HapticPolicy.dragScale(1f) > HapticPolicy.dragScale(0.5f));
        assertTrue(HapticPolicy.dragScale(0.5f) > HapticPolicy.dragScale(0f));
        assertEquals(1f, HapticPolicy.dragScale(4f), 0.0001f);
        assertTrue(HapticPolicy.dragIntervalMs(1f) < HapticPolicy.dragIntervalMs(0f));
        // Even a hard overshoot must not ask the vibrator for effects it cannot separate.
        assertTrue(HapticPolicy.dragIntervalMs(4f) >= HapticPolicy.TEXTURE_GAP_MS);
    }

    @Test public void textureRespectsItsMinimumGap() {
        assertFalse(HapticPolicy.elapsed(1_000, 990, HapticPolicy.TEXTURE_GAP_MS));
        assertTrue(HapticPolicy.elapsed(1_000, 900, HapticPolicy.TEXTURE_GAP_MS));
        // A statement scheduled into the future suppresses texture until it has played.
        assertFalse(HapticPolicy.elapsed(1_000, 1_200, HapticPolicy.STATEMENT_MUTE_MS));
    }
}
