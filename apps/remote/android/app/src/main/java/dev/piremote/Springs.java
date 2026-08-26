package dev.piremote;

import android.view.MotionEvent;
import android.view.View;

import androidx.dynamicanimation.animation.DynamicAnimation;
import androidx.dynamicanimation.animation.SpringAnimation;
import androidx.dynamicanimation.animation.SpringForce;

import java.util.HashMap;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Physics for everything that moves.
 *
 * A duration-based animation has to finish what it started: interrupt it and the value jumps
 * or the curve restarts, because the curve, not the state, is the thing being played. A
 * spring is the opposite — it is a force acting on a value that already has a position and a
 * velocity, so a new target mid-flight simply bends the path it was already on. That is what
 * makes a control feel like an object instead of a slideshow, and it is what Android's own
 * quality guidance asks for in place of fixed easing curves.
 *
 * Every animation here is therefore retargeted rather than restarted: one spring per view and
 * property, kept for the life of the view, moved with {@code animateToFinalPosition}.
 */
final class Springs {
    /** Runs once when a spring next comes to rest, then stops listening. */
    static void onSettled(View view, DynamicAnimation.ViewProperty property, Runnable done) {
        SpringAnimation spring = of(view, property, GOO_STIFFNESS, GOO_DAMPING);
        spring.addEndListener(new DynamicAnimation.OnAnimationEndListener() {
            @Override public void onAnimationEnd(DynamicAnimation animation, boolean cancelled,
                                                float value, float velocity) {
                spring.removeEndListener(this);
                done.run();
            }
        });
    }

    /** A press: fast, with just enough overshoot to feel like it rebounds. */
    static final float PRESS_STIFFNESS = 2600f, PRESS_DAMPING = 0.62f;
    /** Something arriving: loose and bouncy. */
    static final float POP_STIFFNESS = 900f, POP_DAMPING = 0.5f;
    /** A panel travelling a long way: quick, and settling without a wobble. */
    static final float SLIDE_STIFFNESS = 550f, SLIDE_DAMPING = 0.9f;
    /** Thick, viscous motion, for things that are supposed to look like they pour. */
    static final float GOO_STIFFNESS = 380f, GOO_DAMPING = 0.62f;

    private static final float PRESSED_SCALE = 0.88f;
    private static final Map<View, Map<DynamicAnimation.ViewProperty, SpringAnimation>> SPRINGS = new WeakHashMap<>();

    private Springs() {}

    /** The spring for one view and property, created once and retargeted forever after. */
    static SpringAnimation of(View view, DynamicAnimation.ViewProperty property, float stiffness, float damping) {
        Map<DynamicAnimation.ViewProperty, SpringAnimation> byProperty =
            SPRINGS.computeIfAbsent(view, key -> new HashMap<>());
        SpringAnimation spring = byProperty.get(property);
        if (spring == null) {
            spring = new SpringAnimation(view, property);
            spring.setSpring(new SpringForce().setStiffness(stiffness).setDampingRatio(damping));
            spring.setMinimumVisibleChange(
                property == DynamicAnimation.ALPHA || property == DynamicAnimation.SCALE_X
                    || property == DynamicAnimation.SCALE_Y
                    ? DynamicAnimation.MIN_VISIBLE_CHANGE_ALPHA
                    : DynamicAnimation.MIN_VISIBLE_CHANGE_PIXELS);
            byProperty.put(property, spring);
        } else {
            spring.getSpring().setStiffness(stiffness).setDampingRatio(damping);
        }
        return spring;
    }

    static void to(View view, DynamicAnimation.ViewProperty property, float value, float stiffness, float damping) {
        of(view, property, stiffness, damping).animateToFinalPosition(value);
    }

    /** Hands a gesture's own velocity to the spring, so the release continues the throw. */
    static void release(View view, DynamicAnimation.ViewProperty property, float value, float velocity,
                        float stiffness, float damping) {
        SpringAnimation spring = of(view, property, stiffness, damping);
        spring.setStartVelocity(velocity);
        spring.animateToFinalPosition(value);
    }

    static void scale(View view, float value, float stiffness, float damping) {
        to(view, DynamicAnimation.SCALE_X, value, stiffness, damping);
        to(view, DynamicAnimation.SCALE_Y, value, stiffness, damping);
    }

    /** Compresses under the finger and rebounds on release, like a key with travel. */
    static void press(View view, boolean down) {
        scale(view, down ? PRESSED_SCALE : 1f, PRESS_STIFFNESS, PRESS_DAMPING);
    }

    /**
     * Makes a control physical. The press follows the finger back out if it slides off the
     * control, because a button you have already rolled off is no longer being pressed.
     *
     * A view has one touch listener, so the spring and whatever else the press should drive
     * are installed together rather than overwriting each other.
     */
    static void tactile(View view, Runnable onDown, Runnable onUp) {
        view.setOnTouchListener((touched, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    press(touched, true);
                    if (onDown != null) onDown.run();
                    break;
                case MotionEvent.ACTION_MOVE:
                    press(touched, inside(touched, event));
                    break;
                case MotionEvent.ACTION_UP:
                    press(touched, false);
                    if (onUp != null) onUp.run();
                    break;
                case MotionEvent.ACTION_CANCEL:
                    press(touched, false);
                    break;
                default:
            }
            return false;
        });
    }

    static void tactile(View view) {
        tactile(view, null, null);
    }

    private static boolean inside(View view, MotionEvent event) {
        float x = event.getX(), y = event.getY();
        return x >= 0 && y >= 0 && x <= view.getWidth() && y <= view.getHeight();
    }

    /** Drops a view in from slightly displaced and transparent, on a bouncy spring. */
    static void enter(View view, float fromTranslationY) {
        view.setAlpha(0f);
        view.setTranslationY(fromTranslationY);
        to(view, DynamicAnimation.ALPHA, 1f, POP_STIFFNESS, 1f);
        to(view, DynamicAnimation.TRANSLATION_Y, 0f, POP_STIFFNESS, POP_DAMPING);
    }
}
