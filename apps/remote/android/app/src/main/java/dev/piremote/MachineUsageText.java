package dev.piremote;

import java.util.ArrayList;
import java.util.List;

final class MachineUsageText {
    private MachineUsageText() {}

    static String summary(Integer cpu, Integer gpu, Integer ram, Integer disk) {
        List<String> values = new ArrayList<>();
        if (cpu != null) values.add("CPU " + cpu + "%");
        if (gpu != null) values.add("GPU " + gpu + "%");
        if (ram != null) values.add("RAM " + ram + "%");
        if (disk != null) values.add("DISK " + disk + "%");
        return String.join(" · ", values);
    }
}
