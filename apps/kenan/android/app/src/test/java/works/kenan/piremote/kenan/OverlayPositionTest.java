package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Test;

public final class OverlayPositionTest {
    private final OverlayPosition.Bounds screen = new OverlayPosition.Bounds(8, 40, 392, 615);

    @Test public void dragHonorsTouchSlop() {
        assertFalse(OverlayPosition.dragged(100, 100, 106, 108, 10));
        assertTrue(OverlayPosition.dragged(100, 100, 107, 109, 10));
    }
    @Test public void edgeSnapAndClampKeepDotInsideAvailableArea() {
        assertEquals(new OverlayPosition.Point(8, 559), OverlayPosition.snap(30, 900, screen, 56, 0));
        assertEquals(new OverlayPosition.Point(336, 40), OverlayPosition.snap(10, -200, screen, 56, 1300));
        assertEquals(new OverlayPosition.Point(8, 40), OverlayPosition.clamp(-500, -500, screen, 56));
    }
    @Test public void dismissalMagnetMovesTowardTarget() {
        OverlayPosition.Point target = new OverlayPosition.Point(180, 540);
        assertTrue(OverlayPosition.nearDismiss(new OverlayPosition.Point(187, 543), 50, target, 52, 72));
        assertFalse(OverlayPosition.nearDismiss(new OverlayPosition.Point(16, 480), 50, target, 52, 72));
        OverlayPosition.Point magnet = OverlayPosition.magnet(new OverlayPosition.Point(140, 520), target, 50, 52);
        assertTrue(magnet.x() > 140 && magnet.x() < 180);
        assertTrue(magnet.y() > 520 && magnet.y() < 540);
    }
    @Test public void savedHeightAdaptsToKeyboardBounds() {
        int restored = OverlayPosition.restoreY(.5f, screen, 56);
        assertEquals(.5f, OverlayPosition.saveY(restored, screen, 56), .002f);
        OverlayPosition.Bounds keyboard = new OverlayPosition.Bounds(8, 40, 392, 360);
        assertEquals(172, OverlayPosition.restoreY(.5f, keyboard, 56));
    }
}
