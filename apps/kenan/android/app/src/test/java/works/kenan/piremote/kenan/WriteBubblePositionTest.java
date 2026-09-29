package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Test;

public final class WriteBubblePositionTest {
    private final WriteBubblePosition.Bounds screen = new WriteBubblePosition.Bounds(8, 40, 392, 615);

    @Test public void dragThresholdUsesRawScreenDistance() {
        assertFalse(WriteBubblePosition.dragged(100, 100, 106, 108, 10));
        assertTrue(WriteBubblePosition.dragged(100, 100, 107, 109, 10));
    }

    @Test public void snapHonorsEdgeAndClampsWithinIme() {
        assertEquals(new WriteBubblePosition.Point(8, 559), WriteBubblePosition.snap(30, 900, screen, 56, 0));
        assertEquals(new WriteBubblePosition.Point(336, 40), WriteBubblePosition.snap(10, -200, screen, 56, 1300));
        assertEquals(new WriteBubblePosition.Point(8, 40), WriteBubblePosition.clamp(-500, -500, screen, 56));
    }

    @Test public void normalizedHeightSurvivesKeyboardResize() {
        int restored = WriteBubblePosition.restoreY(.5f, screen, 56);
        assertEquals(.5f, WriteBubblePosition.saveY(restored, screen, 56), .002f);
        WriteBubblePosition.Bounds keyboard = new WriteBubblePosition.Bounds(8, 40, 392, 360);
        assertEquals(172, WriteBubblePosition.restoreY(.5f, keyboard, 56));
    }
}
