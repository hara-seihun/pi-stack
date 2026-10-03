package works.kenan.piremote.kenan;

final class OverlayPolicy {
    enum Mode { HIDDEN, KENAN, MIC }
    enum Dismissal { KENAN, MIC, BOTH }

    static Mode mode(boolean kenan, boolean mic) { return mic ? Mode.MIC : kenan ? Mode.KENAN : Mode.HIDDEN; }

    static boolean canDismiss(Dismissal target, boolean kenan, boolean mic, boolean busy) {
        return switch (target) {
            case KENAN -> kenan;
            case MIC -> mic && !busy;
            case BOTH -> (kenan || mic) && !busy;
        };
    }

    static void dismiss(Dismissal target, boolean kenan, boolean mic, boolean busy, Runnable hideKenan, Runnable hideMic) {
        if (!canDismiss(target, kenan, mic, busy)) return;
        if (kenan && target != Dismissal.MIC) hideKenan.run();
        if (mic && target != Dismissal.KENAN) hideMic.run();
    }
}
