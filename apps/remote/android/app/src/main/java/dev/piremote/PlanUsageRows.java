package dev.piremote;

final class PlanUsageRows {
    private PlanUsageRows() {}

    static boolean hasValue(String text) {
        return text != null && text.indexOf('%') >= 0;
    }
}
