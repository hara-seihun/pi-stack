package dev.piremote;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * The app's haptic vocabulary. Every touchable surface has a name here, and each name
 * resolves once, at startup, to the best thing this device can actually play.
 *
 * Only what the user does is felt. The app has plenty of its own news — text streaming in,
 * tool calls opening and closing, a turn finishing, the supervisor coming and going — and
 * feeling all of it turns the phone into something that goes off in your hand at the agent's
 * convenience rather than answering your touch. News belongs to the screen, and to the
 * notification when the app is not on it; the vibrator is reserved for replying to a finger.
 *
 * Three qualities of effect exist, in falling order of preference:
 *
 * 1. A composition of {@link VibrationEffect.Composition} primitives. Expressive, and the
 *    only way to build a sensation that rises, falls, or has weight.
 * 2. A {@link HapticFeedbackConstants} value on a view, which the platform renders the same
 *    way as the rest of the system for that interaction and needs no permission.
 *
 * A recipe that reaches neither plays nothing. That is deliberate: Android's
 * haptics guidance is that a buzzy approximation is worse than silence, so the legacy
 * one-shot and waveform calls appear nowhere in this class.
 *
 * Primitives differ wildly in length — on a Pixel 7 a tick is about 30ms and a thud about
 * 330ms — so weight is spent where it means something. Anything that can repeat often stays
 * under roughly 200ms; only a destructive action, a failure, or the end of a turn is allowed
 * to take longer.
 */
final class Haptics {
    enum Feel {
        PRESS, RELEASE, SELECT, TAB, PICK, ARM, DISARM,
        PANEL_OPEN, PANEL_CLOSE, DISMISS,
        THREAD_OPEN, AGENT_OPEN, IGNITE,
        SEND, QUEUE, ABORT, CONFIRM, REJECT, ERROR,
        TOGGLE_ON, TOGGLE_OFF,
        ATTACH, DETACH, UPLOADED, VOICE_START,
        ARCHIVE, RESTORE, DRAG_START, THRESHOLD_ARM, THRESHOLD_DISARM,
        EDGE, SCROLL_TICK, DRAG_TICK, BURST_TICK
    }

    private static final int NONE = -1;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Feel, Recipe> recipes = new EnumMap<>(Feel.class);
    private final Vibrator vibrator;
    private final boolean rich;
    private final VibrationAttributes touch;

    private View anchor;
    private boolean systemEnabled = true;
    private boolean watching = true;
    private long lastTextureMs;
    private long lastStatementMs;
    private long nextStatementAt;

    private float dragProgress;
    private boolean dragging;
    private final Runnable dragTick = new Runnable() {
        @Override public void run() {
            if (!dragging) return;
            texture(Feel.DRAG_TICK, HapticPolicy.dragScale(dragProgress));
            main.postDelayed(this, HapticPolicy.dragIntervalMs(dragProgress));
        }
    };

    Haptics(Context context) {
        this.context = context;
        this.vibrator = loadVibrator(context);
        this.rich = Build.VERSION.SDK_INT >= 31 && vibrator != null && vibrator.hasVibrator();
        this.touch = Build.VERSION.SDK_INT >= 30
            ? new VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_TOUCH).build()
            : null;
        defineVocabulary();
        refreshSystemSetting();
    }

    void setAnchor(View view) {
        anchor = view;
    }

    /**
     * Haptics belong to the moment someone is looking at the app. Nothing is felt without a
     * finger, but a finger can leave: a swipe interrupted by the recents gesture would keep
     * ticking, and a queued beat would arrive at a pocket. Going away drops both.
     */
    void setWatching(boolean value) {
        if (watching == value) return;
        watching = value;
        if (watching) return;
        // Nothing already in flight should arrive after the screen is gone.
        dragging = false;
        main.removeCallbacksAndMessages(null);
        nextStatementAt = 0;
    }

    /** The system touch-feedback switch gates the vibrator paths the way it already gates views. */
    void refreshSystemSetting() {
        systemEnabled = Settings.System.getInt(
            context.getContentResolver(), Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0;
    }

    /** Gives a view a real button feel: energy on the way down, less of it on the way up. */
    void arm(View view) {
        // The vibration and the button's own give are the same event, felt two ways.
        Springs.tactile(view, () -> play(Feel.PRESS, view), () -> play(Feel.RELEASE, view));
    }

    void play(Feel feel) {
        play(feel, anchor);
    }

    void play(Feel feel, View on) {
        emit(feel, on, 1f, false);
    }

    /** Texture obeys a minimum gap and stays out of the way of anything meaningful. */
    private void texture(Feel feel, float intensity) {
        long now = SystemClock.uptimeMillis();
        if (!HapticPolicy.elapsed(now, lastTextureMs, HapticPolicy.TEXTURE_GAP_MS)) return;
        if (!HapticPolicy.elapsed(now, lastStatementMs, HapticPolicy.STATEMENT_MUTE_MS)) return;
        emit(feel, anchor, intensity, true);
    }

    /**
     * A run of evenly spaced ticks, played as one effect so the vibrator does not cancel its
     * own beats. Used where several things leave at once and each should be felt separately.
     */
    void burst(int count, float scale, int gapMs) {
        if (count <= 0) return;
        Recipe recipe = recipes.get(Feel.BURST_TICK);
        if (recipe == null || recipe.mode != Mode.RICH || !enabled()) {
            play(Feel.SELECT);
            return;
        }
        lastStatementMs = SystemClock.uptimeMillis();
        VibrationEffect.Composition composition = VibrationEffect.startComposition();
        for (int i = 0; i < count; i++)
            composition.addPrimitive(recipe.primitives.get(0),
                HapticPolicy.clamp(scale, 0f, 1f), i == 0 ? 0 : Math.max(0, gapMs));
        vibrate(composition.compose());
    }

    /** Distance travelled under the finger, rendered as a surface texture. */
    void scrolled(float travelPixels, float pixelsPerTick) {
        int ticks = HapticPolicy.scrollTicks(travelPixels, pixelsPerTick);
        for (int i = 0; i < ticks; i++) texture(Feel.SCROLL_TICK, 0.16f + 0.05f * i);
    }

    void dragStarted() {
        if (dragging) return;
        dragging = true;
        dragProgress = 0f;
        play(Feel.DRAG_START);
        main.postDelayed(dragTick, HapticPolicy.dragIntervalMs(0f));
    }

    void dragProgress(float progress) {
        dragProgress = HapticPolicy.clamp(progress, 0f, 1f);
    }

    void dragEnded() {
        dragging = false;
        main.removeCallbacks(dragTick);
    }

    private boolean enabled() {
        return systemEnabled && vibrator != null && vibrator.hasVibrator();
    }

    private void emit(Feel feel, View on, float intensity, boolean isTexture) {
        if (!watching) return;
        Recipe recipe = recipes.get(feel);
        if (recipe == null || recipe.mode == Mode.SILENT) return;
        long now = SystemClock.uptimeMillis();
        // Only a composition can erase another one, so only compositions are spaced out.
        // Touch feedback rendered by the platform stays immediate, which is the point of it.
        if (isTexture || recipe.mode != Mode.RICH) {
            if (isTexture) lastTextureMs = now;
            render(recipe, on, intensity);
            return;
        }
        long at = Math.max(now, nextStatementAt);
        if (at - now > HapticPolicy.MAX_STATEMENT_QUEUE_MS) return;
        nextStatementAt = at + HapticPolicy.STATEMENT_SPACING_MS;
        lastStatementMs = at;
        if (at > now) main.postDelayed(() -> render(recipe, on, intensity), at - now);
        else render(recipe, on, intensity);
    }

    private void render(Recipe recipe, View on, float intensity) {
        switch (recipe.mode) {
            case RICH:
                if (!enabled()) return;
                VibrationEffect.Composition composition = VibrationEffect.startComposition();
                for (int i = 0; i < recipe.primitives.size(); i++)
                    composition.addPrimitive(
                        recipe.primitives.get(i),
                        HapticPolicy.clamp(recipe.scales.get(i) * intensity, 0f, 1f),
                        recipe.delays.get(i));
                vibrate(composition.compose());
                return;
            case CONSTANT:
                View target = on == null ? anchor : on;
                if (target != null) target.performHapticFeedback(
                    recipe.chosenConstant, HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
                return;
            default:
        }
    }

    private void vibrate(VibrationEffect effect) {
        if (!watching) return;
        if (touch != null) vibrator.vibrate(effect, touch);
        else vibrator.vibrate(effect);
    }

    private static Vibrator loadVibrator(Context context) {
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager manager = context.getSystemService(VibratorManager.class);
            return manager == null ? null : manager.getDefaultVibrator();
        }
        return context.getSystemService(Vibrator.class);
    }

    private enum Mode { RICH, CONSTANT, SILENT }

    private static final class Recipe {
        final List<Integer> primitives = new ArrayList<>();
        final List<Float> scales = new ArrayList<>();
        final List<Integer> delays = new ArrayList<>();
        // Constants are declared best first; each carries the SDK level that introduced it.
        final List<Integer> constants = new ArrayList<>();
        final List<Integer> constantSdks = new ArrayList<>();
        int chosenConstant = NONE;
        Mode mode = Mode.SILENT;

        Recipe step(int primitive, float scale) {
            return step(primitive, scale, 0);
        }

        Recipe step(int primitive, float scale, int delayMs) {
            primitives.add(primitive);
            scales.add(scale);
            delays.add(delayMs);
            return this;
        }

        Recipe constant(int value) {
            return constant(value, 1);
        }

        Recipe constant(int value, int sdk) {
            constants.add(value);
            constantSdks.add(sdk);
            return this;
        }
    }

    private Recipe feel(Feel key) {
        Recipe recipe = new Recipe();
        recipes.put(key, recipe);
        return recipe;
    }

    private void resolve() {
        for (Recipe recipe : recipes.values()) {
            for (int i = 0; i < recipe.constants.size() && recipe.chosenConstant == NONE; i++)
                if (Build.VERSION.SDK_INT >= recipe.constantSdks.get(i)) recipe.chosenConstant = recipe.constants.get(i);
            if (!recipe.primitives.isEmpty() && rich && supported(recipe)) recipe.mode = Mode.RICH;
            else if (recipe.chosenConstant != NONE) recipe.mode = Mode.CONSTANT;
            else recipe.mode = Mode.SILENT;
        }
    }

    private boolean supported(Recipe recipe) {
        int[] wanted = new int[recipe.primitives.size()];
        for (int i = 0; i < wanted.length; i++) wanted[i] = recipe.primitives.get(i);
        for (boolean available : vibrator.arePrimitivesSupported(wanted)) if (!available) return false;
        return true;
    }

    private void defineVocabulary() {
        int click = VibrationEffect.Composition.PRIMITIVE_CLICK;
        int tick = VibrationEffect.Composition.PRIMITIVE_TICK;
        int lowTick = VibrationEffect.Composition.PRIMITIVE_LOW_TICK;
        int quickRise = VibrationEffect.Composition.PRIMITIVE_QUICK_RISE;
        int slowRise = VibrationEffect.Composition.PRIMITIVE_SLOW_RISE;
        int quickFall = VibrationEffect.Composition.PRIMITIVE_QUICK_FALL;
        int thud = VibrationEffect.Composition.PRIMITIVE_THUD;
        int spin = VibrationEffect.Composition.PRIMITIVE_SPIN;

        // Touch. These are the system's own interactions, so the system's own constants win:
        // a press carries more energy than its release, exactly like a mechanical key.
        feel(Feel.PRESS).constant(HapticFeedbackConstants.VIRTUAL_KEY);
        feel(Feel.RELEASE).constant(HapticFeedbackConstants.VIRTUAL_KEY_RELEASE, 27);
        feel(Feel.SELECT).constant(HapticFeedbackConstants.CONTEXT_CLICK, 23);
        // Where two constants appear, the first is preferred and the second covers older platforms.
        feel(Feel.TAB).constant(HapticFeedbackConstants.SEGMENT_TICK, 34).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.PICK).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.DRAG_START).constant(HapticFeedbackConstants.DRAG_START, 34).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.THRESHOLD_ARM).constant(HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE, 34);
        feel(Feel.THRESHOLD_DISARM).constant(HapticFeedbackConstants.GESTURE_THRESHOLD_DEACTIVATE, 34);
        // A switch that rises into place and drops out of it, falling back on the platform's own.
        feel(Feel.TOGGLE_ON).step(quickRise, 0.6f).step(click, 0.9f).constant(HapticFeedbackConstants.TOGGLE_ON, 34);
        feel(Feel.TOGGLE_OFF).step(quickFall, 0.7f).step(click, 0.8f, 20).constant(HapticFeedbackConstants.TOGGLE_OFF, 34);
        feel(Feel.CONFIRM).step(tick, 0.7f).step(click, 0.9f, 50).constant(HapticFeedbackConstants.CONFIRM, 30);
        feel(Feel.REJECT).step(thud, 1.0f).step(thud, 0.7f, 80).constant(HapticFeedbackConstants.REJECT, 30);

        // Small state changes in the composer.
        feel(Feel.ARM).step(tick, 0.35f).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.DISARM).step(lowTick, 0.3f).constant(HapticFeedbackConstants.CLOCK_TICK);

        // Panels. The rise and fall are timed against the 180ms and 160ms slide animations,
        // so the drawer feels like it is being pulled out and dropped back.
        feel(Feel.PANEL_OPEN).step(quickRise, 0.45f).step(tick, 0.5f, 40).constant(HapticFeedbackConstants.CONTEXT_CLICK, 23);
        feel(Feel.PANEL_CLOSE).step(quickFall, 0.6f).step(tick, 0.5f, 20).constant(HapticFeedbackConstants.CONTEXT_CLICK, 23);
        feel(Feel.DISMISS).step(lowTick, 0.5f).constant(HapticFeedbackConstants.CLOCK_TICK);

        // Opening things. An autonomous agent spins, because it is not yours to drive.
        feel(Feel.THREAD_OPEN).step(quickRise, 0.35f).step(tick, 0.6f).constant(HapticFeedbackConstants.CONTEXT_CLICK, 23);
        feel(Feel.AGENT_OPEN).step(spin, 0.55f).step(tick, 0.6f, 40).constant(HapticFeedbackConstants.CONTEXT_CLICK, 23);
        feel(Feel.IGNITE).step(tick, 0.5f).step(tick, 0.7f, 55).step(click, 1.0f, 55).constant(HapticFeedbackConstants.CONFIRM, 30);

        // Sending and stopping work.
        feel(Feel.SEND).step(quickRise, 0.55f).step(click, 1.0f).constant(HapticFeedbackConstants.CONFIRM, 30);
        feel(Feel.QUEUE).step(tick, 0.5f).step(tick, 0.8f, 60).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.ABORT).step(quickFall, 1.0f).step(thud, 0.9f, 30).constant(HapticFeedbackConstants.REJECT, 30);
        feel(Feel.ERROR).step(thud, 1.0f).step(lowTick, 0.9f, 90).constant(HapticFeedbackConstants.REJECT, 30);

        // Attachments.
        feel(Feel.ATTACH).step(tick, 0.7f).step(click, 0.5f, 50).constant(HapticFeedbackConstants.CONTEXT_CLICK, 23);
        feel(Feel.DETACH).step(lowTick, 0.8f).step(quickFall, 0.5f, 40).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.UPLOADED).step(tick, 0.6f).step(click, 0.8f, 45).constant(HapticFeedbackConstants.CONFIRM, 30);

        // Retiring and restoring threads.
        feel(Feel.ARCHIVE).step(quickFall, 1.0f).step(thud, 0.9f, 40).constant(HapticFeedbackConstants.REJECT, 30);
        feel(Feel.RESTORE).step(quickRise, 0.6f).step(click, 0.8f, 30).constant(HapticFeedbackConstants.CONFIRM, 30);

        feel(Feel.VOICE_START).step(slowRise, 0.7f).step(click, 0.8f).constant(HapticFeedbackConstants.CONFIRM, 30);

        // Surfaces: the end of a list, and the grain of one moving under the finger. Texture
        // recipes carry unit scale because their caller computes the intensity for each tick.
        feel(Feel.EDGE).step(quickFall, 0.45f).constant(HapticFeedbackConstants.CLOCK_TICK);
        feel(Feel.SCROLL_TICK).step(lowTick, 1.0f).constant(HapticFeedbackConstants.SEGMENT_FREQUENT_TICK, 34);
        feel(Feel.DRAG_TICK).step(lowTick, 1.0f).constant(HapticFeedbackConstants.SEGMENT_FREQUENT_TICK, 34);
        // One beat per shape as the new-thread button divides, played as a single composition.
        feel(Feel.BURST_TICK).step(lowTick, 1.0f).constant(HapticFeedbackConstants.SEGMENT_FREQUENT_TICK, 34);

        resolve();
    }
}
