package works.kenan.piremote.kenan;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;

final class NativeHaptics {
    private NativeHaptics() {}

    static boolean play(View anchor, String kind) {
        return anchor.performHapticFeedback(
            feedbackConstant(kind, Build.VERSION.SDK_INT),
            HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
    }

    static int feedbackConstant(String kind, int sdk) {
        return switch (kind == null ? "select" : kind) {
            case "press" -> HapticFeedbackConstants.VIRTUAL_KEY;
            case "release" -> sdk >= 27
                ? HapticFeedbackConstants.KEYBOARD_RELEASE
                : HapticFeedbackConstants.VIRTUAL_KEY;
            case "confirm" -> sdk >= 30
                ? HapticFeedbackConstants.CONFIRM
                : HapticFeedbackConstants.VIRTUAL_KEY;
            case "reject" -> sdk >= 30
                ? HapticFeedbackConstants.REJECT
                : HapticFeedbackConstants.LONG_PRESS;
            default -> HapticFeedbackConstants.CLOCK_TICK;
        };
    }
}
