package dev.piremote;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class MarkdownStreamTest {
    @Test public void retreatsUntilNothingCrossesTheBoundary() {
        // The paragraph crossing the boundary retreats it to 4, which uncovers a span that
        // crossed nothing before and crosses it now. Stopping after one look would leave it cut.
        int[] starts = { 2, 4, 12 };
        int[] ends = { 5, 30, 20 };
        assertEquals(2, MarkdownStream.retreat(18, starts, ends));
    }

    @Test public void keepsABoundaryNoSpanCrosses() {
        assertEquals(9, MarkdownStream.retreat(9, new int[] { 0, 9 }, new int[] { 9, 14 }));
    }

    @Test public void settlesWhereNeitherTextIsCut() {
        // A list item displayed as 5..20 and the same item now rendered as 10..30: a boundary
        // at 25 cuts nothing in what arrives once it has retreated to 10, but 10 is inside the
        // item on screen, whose leading margin would be left over the wrong half of a line.
        int boundary = MarkdownStream.settle(
            25, new int[] { 5 }, new int[] { 20 }, new int[] { 10 }, new int[] { 30 });
        assertEquals(5, boundary);
    }

    @Test public void settlesAtAnAppendWithoutMovingAnything() {
        // A bullet finished at 10 and a new one starting at 11 share no character, so text
        // added on the end is added on the end.
        int boundary = MarkdownStream.settle(
            10, new int[] { 0, 6 }, new int[] { 5, 10 }, new int[] { 0, 6, 11 }, new int[] { 5, 10, 17 });
        assertEquals(10, boundary);
    }

    @Test public void neverSplitsACharacterMadeOfTwo() {
        String shown = "count \uD83D\uDC0D";
        assertEquals(8, MarkdownStream.commonPrefixLength(shown, shown + "s"));
        assertEquals(6, MarkdownStream.commonPrefixLength(shown, "count \uD83D\uDC1B"));
    }
}
