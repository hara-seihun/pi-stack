package works.kenan.piremote.kenan;

import android.view.HapticFeedbackConstants;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class NativeHapticsTest {
    @Test
    public void modernAndroidGetsDistinctTouchResponses() {
        assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, NativeHaptics.feedbackConstant("press", 36));
        assertEquals(HapticFeedbackConstants.KEYBOARD_RELEASE, NativeHaptics.feedbackConstant("release", 36));
        assertEquals(HapticFeedbackConstants.CLOCK_TICK, NativeHaptics.feedbackConstant("select", 36));
        assertEquals(HapticFeedbackConstants.CONFIRM, NativeHaptics.feedbackConstant("confirm", 36));
        assertEquals(HapticFeedbackConstants.REJECT, NativeHaptics.feedbackConstant("reject", 36));
    }

    @Test
    public void olderAndroidUsesSupportedFallbacks() {
        assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, NativeHaptics.feedbackConstant("release", 24));
        assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, NativeHaptics.feedbackConstant("confirm", 24));
        assertEquals(HapticFeedbackConstants.LONG_PRESS, NativeHaptics.feedbackConstant("reject", 24));
    }
}
