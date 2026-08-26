package dev.piremote;

import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.text.Spanned;
import android.util.LruCache;
import android.widget.TextView;

import io.noties.markwon.image.AsyncDrawable;
import io.noties.markwon.image.AsyncDrawableSpan;

/**
 * The pictures markdown has already drawn, kept by what they are pictures of.
 *
 * A formula or an image reaches the screen as an {@link AsyncDrawable}: until its raster
 * exists the span is only as wide as its placeholder text — for LaTeX, the raw source — so
 * the line it sits on is laid out at the wrong width and re-flows when the raster lands.
 * Markwon renders every span it is handed, and the loader's own cache is keyed by the
 * drawable instance, so the same formula rendered a second time is a second instance and a
 * second render. That is why an answer being streamed shows its mathematics dissolving back
 * into TeX and reassembling: nothing about it changed, but everything about it was new.
 *
 * A raster is a pure function of what it depicts, so it is kept by that: the span class,
 * which is what separates a block formula from the same formula inline, the drawable's
 * destination, which is the LaTeX itself or the image's URL, and the size of the text it was
 * drawn to sit beside, since the same formula is a different picture in a thought and in an
 * answer. Two spans that agree on all three are the same picture, and can hold it between
 * them; that is also why one of them taking over the drawable's callback is harmless, as a
 * still picture never asks to be redrawn. A primed span already has its
 * result when it is first measured, so it is the right size in the first frame it exists and
 * never loads at all — {@link AsyncDrawable#setCallback2} asks the loader only for drawables
 * that have no result yet.
 *
 * Animated results are not kept. Two spans sharing one still picture is invisible; two spans
 * sharing one running animation is a fight over a single playback state.
 */
final class MarkdownRasters {
    private final LruCache<String, Drawable> results = new LruCache<>(96);

    /** Records whatever the text on screen has finished drawing. */
    void keep(Spanned text, TextView view) {
        float textSize = view.getPaint().getTextSize();
        for (AsyncDrawableSpan span : text.getSpans(0, text.length(), AsyncDrawableSpan.class)) {
            AsyncDrawable drawable = span.getDrawable();
            if (!drawable.hasResult()) continue;
            Drawable result = drawable.getResult();
            if (result == null || result instanceof Animatable) continue;
            results.put(key(span, drawable, textSize), result);
        }
    }

    /** Gives freshly rendered spans the pictures they would otherwise wait for. */
    void prime(Spanned text, TextView view) {
        int width = view.getWidth();
        float textSize = view.getPaint().getTextSize();
        for (AsyncDrawableSpan span : text.getSpans(0, text.length(), AsyncDrawableSpan.class)) {
            AsyncDrawable drawable = span.getDrawable();
            if (drawable.hasResult()) continue;
            Drawable result = results.get(key(span, drawable, textSize));
            if (result == null) continue;
            drawable.setResult(result);
            // Bounds resolve against the canvas the span is drawn on. Handing over the width
            // now settles them before the first measure instead of after the first draw.
            if (width > 0) drawable.initWithKnownDimensions(width, textSize);
        }
    }

    private static String key(AsyncDrawableSpan span, AsyncDrawable drawable, float textSize) {
        return span.getClass().getName() + "\u0000" + textSize + "\u0000" + drawable.getDestination();
    }
}
