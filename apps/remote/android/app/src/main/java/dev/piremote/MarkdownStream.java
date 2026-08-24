package dev.piremote;

import android.content.Context;
import android.text.Editable;
import android.text.NoCopySpan;
import android.text.Spannable;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.CharacterStyle;
import android.text.style.ParagraphStyle;
import android.widget.TextView;

import io.noties.markwon.Markwon;
import io.noties.markwon.MarkwonPlugin;

/**
 * Markdown that is edited where it changed instead of being built again.
 *
 * An answer arriving token by token is the same document it was a moment ago with more on the
 * end of it, but the obvious way to show it — render the whole source, hand the result to
 * {@code setText} — throws away everything already on screen and makes it all again. Every
 * span is a new object, so every formula and image is a new picture to draw and appears first
 * as its own source text; every line is laid out again, so the paragraph being read shifts
 * under the eye; and the selection lives in the buffer that was just discarded, so a
 * half-copied quote disappears while it is being copied. None of that is caused by the text
 * changing. It is caused by claiming that all of it changed.
 *
 * So this view keeps its text in a buffer it can edit, and each update is applied as the one
 * edit that actually happened. The new rendering is compared against what is displayed, the
 * boundary is walked back until no span straddles it — a paragraph that grew a word is
 * re-made in full, and the picture cache in {@link MarkdownRasters} keeps its mathematics
 * from flickering while it does — and everything before that point is left exactly as it is,
 * still laid out, still holding its rasters, still holding the selection.
 *
 * A selection that the edit would reach is treated as the reader's claim on the text rather
 * than something to restore afterwards, because restoring a selection is a guess at what
 * someone meant and leaving it alone is not. The update is held until the selection is
 * released, which the reader does by finishing the copy, and it lands then. Nothing else
 * pauses: the transcript keeps growing around it.
 */
final class MarkdownStream extends TextView {
    /** TextView copies what it is given unless the factory hands back something mutable. */
    private static final Spannable.Factory MUTABLE = new Spannable.Factory() {
        @Override public Spannable newSpannable(CharSequence source) {
            return new SpannableStringBuilder(source);
        }
    };

    private final Markwon markwon;
    private final MarkdownRasters rasters;
    private String source = "";
    private String held;

    MarkdownStream(Context context, Markwon markwon, MarkdownRasters rasters) {
        super(context);
        this.markwon = markwon;
        this.rasters = rasters;
        setSpannableFactory(MUTABLE);
        setTextIsSelectable(true);
        setLongClickable(true);
    }

    void setSource(String value) {
        String next = value == null ? "" : value;
        if (next.equals(source)) return;
        Spanned rendered = markwon.toMarkdown(MarkdownCompat.normalizeLatexDelimiters(next));
        CharSequence shown = getText();
        if (!(shown instanceof Editable) || shown.length() == 0) {
            source = next;
            held = null;
            rasters.prime(rendered, this);
            markwon.setParsedMarkdown(this, rendered);
            return;
        }
        Editable buffer = (Editable) shown;
        int boundary = stableBoundary(buffer, rendered);
        if (readerOwns(boundary)) {
            held = next;
            return;
        }
        source = next;
        held = null;
        rasters.keep(buffer, this);
        rasters.prime(rendered, this);
        strip(buffer, boundary);
        buffer.replace(boundary, buffer.length(), rendered.subSequence(boundary, rendered.length()));
        // Everything markwon does around setText still has to happen, because setText is the
        // only part being done differently. It is where a numbered list is told how wide its
        // numbers are, and where the pictures still being drawn are attached to the view; the
        // ones already attached keep what they have, since only drawables without a result are
        // asked for again.
        for (MarkwonPlugin plugin : markwon.getPlugins()) plugin.beforeSetText(this, buffer);
        for (MarkwonPlugin plugin : markwon.getPlugins()) plugin.afterSetText(this);
    }

    /**
     * Takes off the spans that describe the text about to be rewritten.
     *
     * Markwon attaches spans so that they follow an insertion at their end, which also means
     * they are not let go of when the text they cover is deleted: replacing a list item leaves
     * its bullet behind as an empty span at the seam. An empty leading margin is still a
     * leading margin. The line it sits on is indented by it, and by the one left behind by the
     * update before that, and the one before that, so a list item that took a dozen polls to
     * arrive ends up a dozen indents deep and walks off the right edge of the screen. Since
     * nothing before the boundary is touched, that indent then stays wrong for good.
     *
     * Everything starting at or after the boundary is about to be described again by the new
     * rendering, so none of it is worth keeping. The cursor and the selection are marked as
     * things not to copy, and they belong to the reader rather than to the renderer, so they
     * stay.
     */
    private static void strip(Editable buffer, int boundary) {
        for (Object span : buffer.getSpans(boundary, buffer.length(), Object.class)) {
            if (span instanceof NoCopySpan) continue;
            if (buffer.getSpanStart(span) >= boundary) buffer.removeSpan(span);
        }
    }

    @Override protected void onSelectionChanged(int start, int end) {
        super.onSelectionChanged(start, end);
        if (start == end) release();
    }

    @Override protected void onFocusChanged(boolean focused, int direction, android.graphics.Rect previous) {
        super.onFocusChanged(focused, direction, previous);
        // A view that lost focus has no selection to protect, however it came to lose it.
        if (!focused) release();
    }

    /** Lets through whatever arrived while the reader was holding the text. */
    private void release() {
        if (held == null) return;
        String pending = held;
        held = null;
        post(() -> setSource(pending));
    }

    /** True when the reader is holding text that this edit would move out from under them. */
    private boolean readerOwns(int boundary) {
        int start = getSelectionStart();
        int end = getSelectionEnd();
        // An insertion exactly at the selection's end extends it, so touching it counts.
        return start != end && Math.max(start, end) >= boundary;
    }

    /** The first offset that has to be rewritten for the displayed text to become the new one. */
    private static int stableBoundary(Spanned shown, Spanned next) {
        int[][] displayed = spanBounds(shown);
        int[][] arriving = spanBounds(next);
        return settle(commonPrefixLength(shown, next), displayed[0], displayed[1], arriving[0], arriving[1]);
    }

    /**
     * Walks the boundary back until it crosses no span in either text. Retreating for one of
     * them can uncover a span in the other, so the two take turns until neither moves: a
     * boundary clear of the new rendering but cutting through what is displayed would leave
     * the surviving half of a bold run, or a list item's leading margin over text that is no
     * longer the list item.
     */
    static int settle(int boundary, int[] shownStarts, int[] shownEnds, int[] nextStarts, int[] nextEnds) {
        for (int previous = -1; previous != boundary && boundary > 0;) {
            previous = boundary;
            boundary = retreat(boundary, shownStarts, shownEnds);
            boundary = retreat(boundary, nextStarts, nextEnds);
        }
        return boundary;
    }

    /** Where every span that styles a character or a paragraph starts and ends. */
    private static int[][] spanBounds(Spanned text) {
        int length = text.length();
        Object[] characters = text.getSpans(0, length, CharacterStyle.class);
        Object[] paragraphs = text.getSpans(0, length, ParagraphStyle.class);
        int[] starts = new int[characters.length + paragraphs.length];
        int[] ends = new int[starts.length];
        for (int i = 0; i < characters.length; i++) {
            starts[i] = text.getSpanStart(characters[i]);
            ends[i] = text.getSpanEnd(characters[i]);
        }
        for (int i = 0; i < paragraphs.length; i++) {
            starts[characters.length + i] = text.getSpanStart(paragraphs[i]);
            ends[characters.length + i] = text.getSpanEnd(paragraphs[i]);
        }
        return new int[][] { starts, ends };
    }

    /** How far the two agree, never splitting a character that takes two of them. */
    static int commonPrefixLength(CharSequence shown, CharSequence next) {
        int limit = Math.min(shown.length(), next.length());
        int common = 0;
        while (common < limit && shown.charAt(common) == next.charAt(common)) common++;
        if (common > 0 && common < limit && Character.isHighSurrogate(shown.charAt(common - 1))) common--;
        return common;
    }

    /**
     * Walks a boundary back until no span crosses it. A span that started before it and ends
     * after it describes text on both sides, so the half left behind would be a span cut in
     * two: a formula truncated to its opening, a bold run with no end. Retreating to where
     * such a span begins re-makes it whole, and has to be repeated, because the span uncovered
     * by one retreat can itself be crossed by another.
     */
    static int retreat(int boundary, int[] starts, int[] ends) {
        int result = boundary;
        for (boolean moved = true; moved && result > 0;) {
            moved = false;
            for (int i = 0; i < starts.length; i++) {
                if (starts[i] < result && ends[i] > result) {
                    result = starts[i];
                    moved = true;
                }
            }
        }
        return Math.max(0, result);
    }
}
