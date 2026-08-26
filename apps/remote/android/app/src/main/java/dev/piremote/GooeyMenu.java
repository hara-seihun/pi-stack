package dev.piremote;

import android.content.Context;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.dynamicanimation.animation.DynamicAnimation;

import java.util.ArrayList;
import java.util.List;

/**
 * One button that becomes its choices, and choices that become their choices.
 *
 * The button sits at the right of the drawer's header, where the tabs are; pressing it draws
 * it down to nothing as the destinations draw up out of the same spot, so what divides is one
 * body of liquid rather than a container emitting contents. Pressing a destination does the
 * same thing one level down: the other destinations are pulled into the one that was touched,
 * and its models rise out of that spot rather than travelling back to the button first. The
 * liquid always divides where the finger last was.
 *
 * The division is real rather than illustrated. The layer holding the coloured shapes is
 * blurred and then passed through a colour matrix that drives alpha to a hard edge, so two
 * shapes still overlapping after the blur cross that edge as one silhouette, and the neck
 * between them thins and snaps as they travel. Once everything has come to rest the filter is
 * dropped: the choices are separate things by then and should look like it, which also means
 * the blur costs nothing except while something is actually moving.
 *
 * Icons cannot go through the threshold, which would eat them, so they ride in a second
 * unfiltered layer that travels with the shapes. Each stage keeps its own set of shapes, so a
 * destination can stay on screen while the models it turns into rise out of it.
 *
 * The menu resolves touches itself, in {@link #spotAt}, rather than letting each dot answer
 * for itself. The dots are one pool of views reused by every stage: they all sit stacked on
 * the button and travel by transform, so a dot that is not currently a choice still occupies
 * the button's own square, and Android hit-tests a view scaled to nothing against its
 * untouched layout box. Asking the views would therefore let an idle dot swallow the choice
 * drawn over it — which is exactly the one that lands under the finger. What can be touched is
 * instead derived from what each row is offering, so the answer that decides where a tap goes
 * and the answer that decides whether the menu was dismissed are the same answer. The dots
 * keep their click listeners for assistive activation and are inert to touch.
 *
 * Below API 31 there is no {@link RenderEffect} and the same division happens without the
 * liquid.
 */
final class GooeyMenu extends FrameLayout {
    interface OnStart {
        void start(String destinationId, String modelId);
    }

    /** Told when the menu takes over the header, so whatever shares that row can get out of the way. */
    interface OnExpansion {
        void expansion(boolean expanded);
    }

    private interface Pick {
        void at(int index);
    }

    /** A destination, or a model within one. Children make it a two-step choice. */
    static final class Choice {
        final String id, label;
        final int accent, icon;
        final List<Choice> children;

        Choice(String id, String label, int accent, int icon, List<Choice> children) {
            this.id = id;
            this.label = label;
            this.accent = accent;
            this.icon = icon;
            this.children = children == null ? new ArrayList<>() : children;
        }
    }

    /** A dot the finger is on: one choice of one row, or the button itself. */
    private static final class Spot {
        final Row row;
        final int index;
        final ImageView face;

        Spot(Row row, int index, ImageView face) {
            this.row = row;
            this.index = index;
            this.face = face;
        }

        boolean same(Spot other) {
            return other != null && other.row == row && other.index == index;
        }
    }

    /**
     * A dot. Touch belongs to the menu, which knows which dots are choices and where they are
     * drawn; the click listener remains so that an assistive click still lands.
     */
    private static final class Face extends ImageView {
        Face(Context context) {
            super(context);
        }

        @Override public boolean onTouchEvent(MotionEvent event) {
            return false;
        }
    }

    private static final int MAX_ITEMS = 4;
    private static final int STAGGER_MS = 45;
    /** Icons are cut out of their dot, so which way round depends on how dark the dot is. */
    private static final int ICON_ON_LIGHT = 0xff0b0f14, ICON_ON_DARK = 0xfff2f4f6;
    private static final float RETRACT_STIFFNESS = 900f;
    /** Stiff, and aimed well below the row, so what is visible of the drop is it speeding up. */
    private static final float FALL_STIFFNESS = 520f;
    /** Slack, so a falling dot is still a dot on the way down and only thins out once it is gone. */
    private static final float MELT_STIFFNESS = 150f;

    private final FrameLayout shapes = new FrameLayout(getContext());
    private final FrameLayout faces = new FrameLayout(getContext());
    private final int trigger, pill, gap, fall;
    private final Haptics haptics;
    private final View triggerShape;
    private final ImageView triggerFace;
    private final Row destinationRow = new Row(this::chooseDestination);
    private final Row modelRow = new Row(this::chooseModel);

    private List<Choice> destinations = new ArrayList<>();
    private Choice chosen;
    private boolean expanded;
    private OnStart onStart;
    private OnExpansion onExpansion;
    private Spot pressed;
    private int movement;

    GooeyMenu(Context context, Haptics haptics, int accent) {
        super(context);
        this.haptics = haptics;
        trigger = dp(44);
        // The choices are the button's own shape and size: one dot becoming several dots.
        pill = dp(46);
        gap = dp(14);
        fall = dp(150);
        setClipChildren(false);
        setClipToPadding(false);
        shapes.setClipChildren(false);
        faces.setClipChildren(false);
        addView(shapes, new LayoutParams(-1, -1));
        addView(faces, new LayoutParams(-1, -1));

        destinationRow.build();
        modelRow.build();

        triggerShape = new View(context);
        triggerShape.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        triggerShape.setBackground(round(accent, trigger / 2f));
        shapes.addView(triggerShape, stacked(trigger));
        triggerFace = icon(R.drawable.ic_plus);
        triggerFace.setContentDescription("New thread");
        triggerFace.setOnClickListener(view -> {
            if (expanded) collapse();
            else open();
        });
        faces.addView(triggerFace, stacked(trigger));
    }

    /**
     * The filtered layer is clipped to its own bounds, so it is laid out taller than the row
     * and shifted back up: a choice dropping out of the row keeps its body all the way down
     * instead of being cut off at the row's edge and leaving a bare icon falling.
     */
    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        shapes.layout(shapes.getLeft(), shapes.getTop(), shapes.getRight(), shapes.getBottom() + fall);
        shapes.setTranslationY(-fall / 2f);
    }

    void setOnStart(OnStart value) {
        onStart = value;
    }

    void setOnExpansion(OnExpansion value) {
        onExpansion = value;
    }

    /** The destinations and their models, exactly as the supervisor describes them. */
    void setDestinations(List<Choice> value) {
        destinations = value == null ? new ArrayList<>() : value;
        if (expanded) collapse();
    }

    boolean hasDestinations() {
        return !destinations.isEmpty();
    }

    void open() {
        if (expanded) return;
        if (destinations.isEmpty()) { haptics.play(Haptics.Feel.REJECT); return; }
        Choice only = destinations.size() == 1 ? destinations.get(0) : null;
        if (only != null && only.children.isEmpty()) {
            haptics.play(Haptics.Feel.SELECT);
            if (onStart != null) onStart.start(only.id, null);
            return;
        }
        expanded = true;
        chosen = only;
        absorbTrigger(true);
        if (onExpansion != null) onExpansion.expansion(true);
        if (only == null) destinationRow.show(destinations, 0f);
        else modelRow.show(only.children, 0f);
    }

    void collapse() {
        if (!expanded) return;
        expanded = false;
        chosen = null;
        int moving = ++movement;
        setGoo(true);
        destinationRow.retractTo(0f);
        modelRow.retractTo(0f);
        Springs.onSettled(triggerShape, DynamicAnimation.SCALE_X, () -> settled(moving));
        absorbTrigger(false);
        if (onExpansion != null) onExpansion.expansion(false);
    }

    /**
     * Anything touched outside the live choices puts the menu back. A menu that stays open
     * behind the next thing you do is a menu you have to remember to close.
     */
    boolean dismissedBy(float rawX, float rawY) {
        if (!expanded) return false;
        int[] at = new int[2];
        getLocationOnScreen(at);
        if (spotAt(rawX - at[0], rawY - at[1]) != null) return false;
        haptics.play(Haptics.Feel.DISMISS);
        collapse();
        return true;
    }

    /**
     * The dot under a point: the button while the menu is closed, otherwise the choice whose
     * place in the row that point falls in, models before destinations because the models rise
     * over the destination they came from. A row offering nothing has nothing to hit.
     */
    private Spot spotAt(float x, float y) {
        if (y < 0 || y > getHeight()) return null;
        if (!expanded) {
            return Math.abs(x - centre()) <= trigger / 2f ? new Spot(null, -1, triggerFace) : null;
        }
        Spot spot = modelRow.spotAt(x);
        return spot != null ? spot : destinationRow.spotAt(x);
    }

    /** Everything rests on the button's own centre, which is where the row's last dot lands. */
    private float centre() {
        return getWidth() - trigger / 2f;
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        float x = event.getX(), y = event.getY();
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                pressed = spotAt(x, y);
                if (pressed == null) return false;
                Springs.press(pressed.face, true);
                haptics.play(Haptics.Feel.PRESS, pressed.face);
                return true;
            case MotionEvent.ACTION_MOVE:
                if (pressed == null) return false;
                // The press follows the finger back out if it slides off the dot it is on.
                Springs.press(pressed.face, pressed.same(spotAt(x, y)));
                return true;
            case MotionEvent.ACTION_UP: {
                Spot spot = pressed;
                pressed = null;
                if (spot == null) return false;
                Springs.press(spot.face, false);
                if (!spot.same(spotAt(x, y))) return true;
                haptics.play(Haptics.Feel.RELEASE, spot.face);
                spot.face.performClick();
                return true;
            }
            case MotionEvent.ACTION_CANCEL:
                if (pressed == null) return false;
                Springs.press(pressed.face, false);
                pressed = null;
                return true;
            default:
                return false;
        }
    }

    /** The button is not a container the choices come out of; it is what they are made of. */
    private void absorbTrigger(boolean into) {
        triggerFace.setClickable(!into);
        Springs.scale(triggerShape, into ? 0f : 1f,
            into ? Springs.GOO_STIFFNESS : RETRACT_STIFFNESS, into ? Springs.GOO_DAMPING : 0.7f);
        Springs.scale(triggerFace, into ? 0f : 1f, Springs.POP_STIFFNESS, into ? 1f : 0.5f);
        Springs.to(triggerFace, DynamicAnimation.ALPHA, into ? 0f : 1f, Springs.POP_STIFFNESS, 1f);
    }

    private void chooseDestination(int index) {
        if (!expanded || index >= destinationRow.items.size()) return;
        Choice choice = destinationRow.items.get(index);
        if (choice.children.isEmpty()) {
            collapse();
            if (onStart != null) onStart.start(choice.id, null);
            return;
        }
        chosen = choice;
        haptics.play(Haptics.Feel.SELECT);
        // The choices not taken drop out of the row while the one that was touched divides,
        // both at once: nothing is gathered up and nothing travels back to the button.
        float origin = destinationRow.targetOf(index);
        destinationRow.dropAllBut(index);
        destinationRow.dissolveAt(index);
        modelRow.show(choice.children, origin);
    }

    private void chooseModel(int index) {
        if (!expanded || chosen == null || index >= modelRow.items.size()) return;
        Choice model = modelRow.items.get(index);
        String destination = chosen.id;
        collapse();
        if (onStart != null) onStart.start(destination, model.id);
    }

    /** Whatever moved last has stopped, so the choices are separate things now. */
    private void settled(int moving) {
        if (moving == movement) setGoo(false);
    }

    /** Everything rests stacked on the trigger, at the right end, so travel is leftward only. */
    private LayoutParams stacked(int size) {
        LayoutParams params = new LayoutParams(size, size, Gravity.END | Gravity.CENTER_VERTICAL);
        params.rightMargin = (trigger - size) / 2;
        return params;
    }

    /** One stage of the menu: a pool of shapes with their icons, and where they come to rest. */
    private final class Row {
        private final List<View> shapes = new ArrayList<>();
        private final List<ImageView> faces = new ArrayList<>();
        private final Pick pick;
        private List<Choice> items = new ArrayList<>();
        private int size;

        Row(Pick pick) {
            this.pick = pick;
            this.size = pill;
        }

        void build() {
            for (int i = 0; i < MAX_ITEMS; i++) {
                View shape = new View(getContext());
                shape.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
                shape.setScaleX(0f);
                shape.setScaleY(0f);
                GooeyMenu.this.shapes.addView(shape, stacked(pill));
                shapes.add(shape);

                ImageView face = icon(0);
                face.setScaleX(0f);
                face.setScaleY(0f);
                face.setAlpha(0f);
                final int index = i;
                face.setOnClickListener(view -> pick.at(index));
                GooeyMenu.this.faces.addView(face, stacked(pill));
                faces.add(face);
            }
            offer(new ArrayList<>());
        }

        /**
         * What this row is offering, which is the whole of what can be touched in it: the dots
         * beyond it are the pool's leftovers, and a dot on its way out is already gone. The
         * click listeners follow, so an assistive click cannot reach a dot a finger cannot.
         */
        void offer(List<Choice> values) {
            items = values;
            for (int i = 0; i < MAX_ITEMS; i++) faces.get(i).setClickable(i < values.size());
        }

        /**
         * The choices sit in a row against the right edge, the last of them landing exactly
         * where the button was, so the run of dots grows leftward out of it.
         */
        float targetOf(int index) {
            int count = Math.max(1, items.size());
            return -(count - 1 - index) * (size + gap);
        }

        /**
         * Which choice a point belongs to. The row is divided at the halfway line between
         * neighbours rather than at the edge of each dot, so the gaps belong to the dot beside
         * them instead of dismissing the menu.
         */
        Spot spotAt(float x) {
            for (int i = 0; i < items.size(); i++)
                if (Math.abs(x - centre() - targetOf(i)) <= (size + gap) / 2f)
                    return new Spot(this, i, faces.get(i));
            return null;
        }

        void show(List<Choice> values, float originX) {
            size = sizeFor(values.size());
            offer(values);
            int moving = ++movement;
            setGoo(true);
            for (int i = 0; i < MAX_ITEMS; i++) {
                View shape = shapes.get(i);
                ImageView face = faces.get(i);
                if (i >= values.size()) continue;
                Choice choice = values.get(i);
                shape.setBackground(round(choice.accent, pill / 2f));
                face.setColorFilter(glyphOn(choice.accent));
                resize(shape, size);
                resize(face, size);
                face.setImageResource(choice.icon);
                face.setContentDescription(choice.children.isEmpty()
                    ? "Start a " + choice.label + " thread"
                    : choice.label + " threads");
                // Everything begins as part of whatever it came out of, at that thing's position.
                stopFalling(shape); stopFalling(face);
                shape.setTranslationX(originX);
                face.setTranslationX(originX);
                shape.setScaleX(0f); shape.setScaleY(0f);
                face.setScaleX(0f); face.setScaleY(0f); face.setAlpha(0f);
                float target = targetOf(i);
                boolean last = i == values.size() - 1;
                postDelayed(() -> {
                    if (!expanded) return;
                    Springs.to(shape, DynamicAnimation.TRANSLATION_X, target, Springs.GOO_STIFFNESS, Springs.GOO_DAMPING);
                    Springs.scale(shape, 1f, Springs.GOO_STIFFNESS, Springs.GOO_DAMPING);
                    Springs.to(face, DynamicAnimation.TRANSLATION_X, target, Springs.GOO_STIFFNESS, Springs.GOO_DAMPING);
                    Springs.scale(face, 1f, Springs.POP_STIFFNESS, Springs.POP_DAMPING);
                    Springs.to(face, DynamicAnimation.ALPHA, 1f, Springs.POP_STIFFNESS, 1f);
                    if (last) Springs.onSettled(shape, DynamicAnimation.TRANSLATION_X, () -> settled(moving));
                }, (long) i * STAGGER_MS);
            }
            // One tick per shape as the liquid divides, at the pace the shapes actually leave.
            haptics.burst(values.size(), 0.5f, STAGGER_MS);
        }

        /** What was not chosen simply falls out of the row, shrinking as it goes. */
        void dropAllBut(int keep) {
            ++movement;
            setGoo(true);
            for (int i = 0; i < MAX_ITEMS; i++) {
                if (i == keep) continue;
                for (View view : new View[]{ shapes.get(i), faces.get(i) }) {
                    Springs.to(view, DynamicAnimation.TRANSLATION_Y, fall, FALL_STIFFNESS, 1f);
                    Springs.scale(view, 0f, MELT_STIFFNESS, 1f);
                }
                Springs.to(faces.get(i), DynamicAnimation.ALPHA, 0f, MELT_STIFFNESS, 1f);
            }
            offer(new ArrayList<>());
        }

        void dissolveAt(int index) {
            if (index >= shapes.size()) return;
            Springs.scale(shapes.get(index), 0f, Springs.GOO_STIFFNESS, 1f);
            Springs.scale(faces.get(index), 0f, Springs.POP_STIFFNESS, 1f);
            Springs.to(faces.get(index), DynamicAnimation.ALPHA, 0f, Springs.POP_STIFFNESS, 1f);
        }

        void retractTo(float x) {
            for (int i = 0; i < MAX_ITEMS; i++) {
                // Faster coming back than going out: the liquid is pulled in, not poured.
                slide(shapes.get(i), faces.get(i), x, RETRACT_STIFFNESS);
                stopFalling(shapes.get(i)); stopFalling(faces.get(i));
            }
            offer(new ArrayList<>());
        }

        private void slide(View shape, ImageView face, float x, float stiffness) {
            float pull = stiffness == 0f ? Springs.GOO_STIFFNESS : stiffness;
            Springs.to(shape, DynamicAnimation.TRANSLATION_X, x, pull, 1f);
            Springs.scale(shape, 0f, pull, 1f);
            Springs.to(face, DynamicAnimation.TRANSLATION_X, x, pull, 1f);
            Springs.scale(face, 0f, Springs.POP_STIFFNESS, 1f);
            Springs.to(face, DynamicAnimation.ALPHA, 0f, Springs.POP_STIFFNESS, 1f);
        }

        private int sizeFor(int count) {
            int available = getWidth() - getPaddingLeft() - getPaddingRight() - gap * (count - 1);
            if (available <= 0) return pill;
            return Math.max(dp(30), Math.min(pill, available / Math.max(1, count)));
        }
    }

    /** Puts a dot that fell out of the row back on it, invisibly, before it is used again. */
    private void stopFalling(View view) {
        Springs.of(view, DynamicAnimation.TRANSLATION_Y, FALL_STIFFNESS, 1f).cancel();
        view.setTranslationY(0f);
    }

    private void resize(View view, int size) {
        LayoutParams params = (LayoutParams) view.getLayoutParams();
        if (params.width == size && params.height == size) return;
        params.width = size;
        params.height = size;
        params.rightMargin = (trigger - size) / 2;
        view.setLayoutParams(params);
    }

    /**
     * Blur, then a colour matrix that multiplies alpha far past its range and subtracts most
     * of it back. Everything softer than the threshold disappears and everything above it
     * becomes solid, so overlapping blurs fuse into one edge instead of two.
     */
    private void setGoo(boolean on) {
        if (Build.VERSION.SDK_INT < 31) return;
        if (!on) {
            shapes.setRenderEffect(null);
            return;
        }
        float radius = dp(10);
        RenderEffect blur = RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.DECAL);
        ColorMatrix threshold = new ColorMatrix(new float[]{
            1, 0, 0, 0, 0,
            0, 1, 0, 0, 0,
            0, 0, 1, 0, 0,
            0, 0, 0, 26, -2600,
        });
        shapes.setRenderEffect(RenderEffect.createChainEffect(
            RenderEffect.createColorFilterEffect(new ColorMatrixColorFilter(threshold)), blur));
    }

    private ImageView icon(int resource) {
        ImageView view = new Face(getContext());
        if (resource != 0) view.setImageResource(resource);
        view.setScaleType(ImageView.ScaleType.FIT_CENTER);
        int inset = dp(11);
        view.setPadding(inset, inset, inset, inset);
        view.setColorFilter(ICON_ON_LIGHT);
        return view;
    }

    /** Perceived brightness of the dot, so a dark accent gets a light icon rather than a hole. */
    private static int glyphOn(int accent) {
        float luminance = (0.2126f * ((accent >> 16) & 0xff)
            + 0.7152f * ((accent >> 8) & 0xff) + 0.0722f * (accent & 0xff)) / 255f;
        return luminance < 0.5f ? ICON_ON_DARK : ICON_ON_LIGHT;
    }

    private GradientDrawable round(int color, float radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setCornerRadius(radius);
        drawable.setColor(color);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
