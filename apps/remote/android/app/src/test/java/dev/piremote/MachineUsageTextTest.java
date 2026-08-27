package dev.piremote;

import static org.junit.Assert.*;

import org.junit.Test;

public class MachineUsageTextTest {
    @Test public void omitsHardwareTheMachineDoesNotExpose() {
        assertEquals("CPU 53% · RAM 79% · DISK 74%",
            MachineUsageText.summary(53, null, 79, 74));
    }

    @Test public void includesMeasuredGpuUsage() {
        assertEquals("CPU 12% · GPU 44% · RAM 60% · DISK 70%",
            MachineUsageText.summary(12, 44, 60, 70));
    }

    @Test public void retainsAvailableCapacityWhileCpuWarmsUp() {
        assertEquals("RAM 79% · DISK 74%",
            MachineUsageText.summary(null, null, 79, 74));
    }
}
