package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Test;

public final class WriteTextTest {
    @Test public void mergesAtCursorWithoutReplacingSurroundings() {
        WriteText.Insertion result = WriteText.insert("hello world", 6, 6, "beautiful");
        assertEquals("hello beautiful world", result.text());
        assertEquals(6, result.start());
        assertEquals(15, result.end());
    }

    @Test public void replacesSelectedTextAndHandlesMissingCursor() {
        assertEquals("hello friend!", WriteText.insert("hello world!", 6, 11, "friend").text());
        assertEquals("hello there", WriteText.insert("hello", -1, -1, "there").text());
        assertEquals("Kelana, hello", WriteText.insert(", hello", 0, 0, "Kelana").text());
    }

    @Test public void learnsOnlyEditedWordInsideInsertedSpan() {
        String original = "Hello kelana today";
        WriteText.Correction correction = WriteText.changedWord(original, "Hello Kelana today", 6, 12);
        assertNotNull(correction);
        assertEquals("kelana", correction.inserted());
        assertEquals("Kelana", correction.replacement());
        assertNull(WriteText.changedWord(original, "Hello kelana Today", 6, 12));
    }

    @Test public void ignoresFormattingAndOutsideEdits() {
        assertNull(WriteText.changedWord("one two", "one  two", 4, 7));
        assertNull(WriteText.changedWord("hello one", "Hello one", 6, 9));
    }
}
