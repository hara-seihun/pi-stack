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
        return switch (NativeState.require(NativeState.Haptic.class, kind == null ? "select" : kind)) {
            case PRESS -> HapticFeedbackConstants.VIRTUAL_KEY;
            case RELEASE -> sdk >= 27
                ? HapticFeedbackConstants.KEYBOARD_RELEASE
                : HapticFeedbackConstants.VIRTUAL_KEY;
            case CONFIRM -> sdk >= 30
                ? HapticFeedbackConstants.CONFIRM
                : HapticFeedbackConstants.VIRTUAL_KEY;
            case REJECT -> sdk >= 30
                ? HapticFeedbackConstants.REJECT
                : HapticFeedbackConstants.LONG_PRESS;
            case SELECT -> HapticFeedbackConstants.CLOCK_TICK;
        };
    }
}
