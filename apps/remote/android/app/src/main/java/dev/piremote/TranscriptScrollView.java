package dev.piremote;

import android.content.Context;
import android.util.TypedValue;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * A transcript surface anchored to its end instead of its start.
 *
 * An ordinary scroll view treats the top of its content as the stable point, which is wrong
 * for a conversation: new text appears at the end, the last message grows token by token, and
 * a reader who has scrolled up must not be dragged along. Both behaviours are invariants over
 * layout, not one-off actions, so they are enforced here in {@link #onLayout} — in the same
 * frame that produced the new content, before it is drawn. Scheduling a scroll with
 * {@code post()} after adding a view is a guess about when layout will finish; it lands a
 * frame late as a visible jump, and it misses entirely when a picture, a formula, or a tool
 * card resolves its height later.
 *
 * Two states, each with one invariant:
 *
 * - Following. {@code scrollY} is held at the end of the content, so growth is revealed
 *   immediately and the keyboard opening does not push the newest line out of sight.
 * - Reading. The content under the viewport does not move. Appending below the viewport
 *   already satisfies this; growth *above* it does not, so the view remembers the block at
 *   the top of the screen and restores its position after layout. That is what keeps a
 *   running tool card from shoving the paragraph being read off the screen.
 *
 * Only the user changes state. A layout that happens to move the scroll position must never
 * be mistaken for the reader's intent, which is why scroll events are attributed to a finger
 * or a fling before they are allowed to mean anything.
 *
 * Touching the transcript is the third way of saying "hold still", and it does not have to
 * become a scroll to mean it. Following the end drags the words out from under the finger
 * that is trying to hold them — which is why a word could not be picked out of an answer
 * while it was being written; the press was on text that had already moved on. So a finger
 * on the transcript, and afterwards a selection it left behind, suspend following for as
 * long as they last. The end is rejoined the moment the text is let go.
 */
final class TranscriptScrollView extends ScrollView {
    /** Reported for scrolls the user caused, so callers never react to their own layout. */
    interface ScrollListener {
        void onUserScroll(int scrollY, int previousScrollY, boolean atEnd, boolean atStart);
    }

    /** How near the end still counts as being at it, for re-engaging follow. */
    private static final int FOLLOW_SLACK_DP = 48;
    /** A fling is still the user scrolling; it is over once the movement it caused stops. */
    private static final long FLING_SETTLE_MS = 250;

    private final int followSlack;
    private final Runnable endFling = () -> flinging = false;

    private boolean following = true;
    private boolean touching, flinging, inLayout;
    private ScrollListener listener;
    private View anchor;
    private int anchorOffset;

    TranscriptScrollView(Context context) {
        super(context);
        followSlack = (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, FOLLOW_SLACK_DP, context.getResources().getDisplayMetrics());
    }

    void setScrollListener(ScrollListener value) {
        listener = value;
    }

    boolean isFollowing() {
        return following;
    }

    /**
     * Returns to the end and stays there. Sending a message is a statement that you want to
     * see the answer, so it re-engages following wherever the transcript was left.
     */
    void follow() {
        following = true;
        int target = maxScroll();
        if (getScrollY() != target) scrollTo(0, target);
    }

    /** Starts a new transcript at the end, before any content exists to measure. */
    void resetToEnd() {
        following = true;
        anchor = null;
        scrollTo(0, 0);
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        inLayout = true;
        super.onLayout(changed, left, top, right, bottom);
        if (following && !touching && !selectionHeld()) {
            int target = maxScroll();
            if (getScrollY() != target) scrollTo(0, target);
        } else {
            if (anchor != null && anchor.isAttachedToWindow()) {
                int target = clampScroll(contentTop(anchor) - anchorOffset);
                if (getScrollY() != target) scrollTo(0, target);
            }
        }
        // Held from the position just settled on, so a selection begun while following has
        // somewhere to hold from in the very frame it appears.
        captureAnchor();
        inLayout = false;
    }

    @Override protected void onScrollChanged(int x, int y, int oldX, int oldY) {
        super.onScrollChanged(x, y, oldX, oldY);
        // A scroll the view performed on itself carries no intent and must not change state.
        if (inLayout) return;
        if (flinging) {
            removeCallbacks(endFling);
            postDelayed(endFling, FLING_SETTLE_MS);
        }
        if (!touching && !flinging) return;
        int end = maxScroll();
        following = end - y <= followSlack;
        captureAnchor();
        if (listener != null) listener.onUserScroll(y, oldY, y >= end, y <= 0);
    }

    /**
     * Every touch in the transcript is seen here, which is the only hook that cannot be shut
     * off. Selectable text consumes the press and then, once it begins a selection, asks its
     * parents to stop intercepting — and a view that watched {@code onInterceptTouchEvent}
     * would stop being told anything at that moment, including that the finger was lifted. It
     * would believe a finger was still down forever after the first word anyone selected, and
     * quietly stop following the end for the rest of the session.
     */
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_MOVE:
                touching = true;
                flinging = false;
                removeCallbacks(endFling);
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                touching = false;
                flinging = true;
                removeCallbacks(endFling);
                postDelayed(endFling, FLING_SETTLE_MS);
                break;
            default:
        }
        return super.dispatchTouchEvent(event);
    }

    /** True while text in here is selected, wherever the transcript happens to be. */
    private boolean selectionHeld() {
        View focused = findFocus();
        return focused instanceof TextView
            && ((TextView) focused).getSelectionStart() != ((TextView) focused).getSelectionEnd();
    }

    private int maxScroll() {
        View content = getChildAt(0);
        if (content == null) return 0;
        return Math.max(0, content.getHeight() + getPaddingTop() + getPaddingBottom() - getHeight());
    }

    private int clampScroll(int value) {
        return Math.max(0, Math.min(value, maxScroll()));
    }

    /**
     * Remembers the deepest block crossing the top of the viewport, and where it sits relative
     * to it. Restoring that relationship after layout is what "the page did not move" means.
     */
    private void captureAnchor() {
        anchor = null;
        View content = getChildAt(0);
        if (content == null) return;
        int viewportTop = getScrollY();
        View current = content;
        while (current instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) current;
            View crossing = null;
            for (int i = 0; i < group.getChildCount() && crossing == null; i++) {
                View child = group.getChildAt(i);
                if (child.getVisibility() == GONE) continue;
                if (contentTop(child) + child.getHeight() > viewportTop) crossing = child;
            }
            if (crossing == null) break;
            current = crossing;
        }
        anchor = current;
        anchorOffset = contentTop(current) - viewportTop;
    }

    /** A descendant's top in this view's scrolling coordinates. */
    private int contentTop(View view) {
        int top = 0;
        View current = view;
        while (current != null && current != this) {
            top += current.getTop();
            current = current.getParent() instanceof View ? (View) current.getParent() : null;
        }
        return top;
    }
}
