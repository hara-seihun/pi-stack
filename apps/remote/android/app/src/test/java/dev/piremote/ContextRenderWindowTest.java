package dev.piremote;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class ContextRenderWindowTest {
    @Test public void pinsAlwaysSectionsAndStartsAtTheRecentTail() {
        ContextRenderWindow window = new ContextRenderWindow(3, 2, 6);
        List<String> keys = List.of("system", "tools", "m1", "m2", "m3", "m4", "m5");

        ContextRenderWindow.Selection selected = window.select(keys, 2);

        assertEquals(4, selected.start);
        assertEquals(2, selected.hidden);
    }

    @Test public void keepsItsAnchorWhenNewEntriesArrive() {
        ContextRenderWindow window = new ContextRenderWindow(3, 2, 6);
        List<String> first = new ArrayList<>(List.of("system", "m1", "m2", "m3", "m4"));
        assertEquals(2, window.select(first, 1).start);
        first.add("m5");

        ContextRenderWindow.Selection selected = window.select(first, 1);

        assertEquals(2, selected.start);
        assertEquals(1, selected.hidden);
    }

    @Test public void expandsTowardOlderHistoryOnePageAtATime() {
        ContextRenderWindow window = new ContextRenderWindow(2, 2, 4);
        List<String> keys = List.of("system", "m1", "m2", "m3", "m4", "m5");
        window.select(keys, 1);

        assertEquals(2, window.expand(keys, 1).start);
        assertEquals(1, window.expand(keys, 1).start);
    }

    @Test public void boundsAutomaticGrowthWithoutLosingStableTailViews() {
        ContextRenderWindow window = new ContextRenderWindow(2, 2, 4);
        window.select(List.of("system", "m1", "m2"), 1);

        ContextRenderWindow.Selection selected = window.select(
            List.of("system", "m1", "m2", "m3", "m4", "m5"), 1);

        assertEquals(2, selected.start);
        assertEquals(1, selected.hidden);
    }

    @Test public void explicitExpansionIsNotTrimmedByAutomaticLimit() {
        ContextRenderWindow window = new ContextRenderWindow(2, 3, 4);
        List<String> first = List.of("system", "m1", "m2", "m3", "m4", "m5");
        assertEquals(1, window.expand(first, 1).start);

        ContextRenderWindow.Selection selected = window.select(
            List.of("system", "m1", "m2", "m3", "m4", "m5", "m6", "m7"), 1);

        assertEquals(1, selected.start);
    }

    @Test public void fallsBackToTheTailWhenCompactionRemovesTheAnchor() {
        ContextRenderWindow window = new ContextRenderWindow(2, 2, 4);
        window.select(List.of("system", "old1", "old2", "old3"), 1);

        ContextRenderWindow.Selection selected = window.select(List.of("system", "summary", "new"), 1);

        assertEquals(1, selected.start);
        assertEquals(0, selected.hidden);
    }
}
