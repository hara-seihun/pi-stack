package dev.piremote;

import static org.junit.Assert.*;

import org.junit.Test;

public class PlanUsageRowsTest {
    @Test public void keepsCardsWithMeasuredPlanValues() {
        assertTrue(PlanUsageRows.hasValue("64% (+3%)"));
        assertTrue(PlanUsageRows.hasValue("F 70% (-2%) · W 55% (+4%)"));
    }

    @Test public void hidesLoadingAndUnconfiguredPlanCards() {
        assertFalse(PlanUsageRows.hasValue("—"));
        assertFalse(PlanUsageRows.hasValue("F — · W —"));
        assertFalse(PlanUsageRows.hasValue(null));
    }
}
