package dev.piremote;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class TextDocumentTest {
    @Test public void suppliesAndNormalizesTextDocumentNames() {
        assertEquals("pasted-text.txt", TextDocument.fileName(null));
        assertEquals("pasted-text.txt", TextDocument.fileName("   "));
        assertEquals("notes.txt", TextDocument.fileName(" notes "));
        assertEquals("notes.md", TextDocument.fileName(" notes.md "));
    }

    @Test public void encodesPastedTextAsUtf8() {
        assertArrayEquals("hello 🌙".getBytes(StandardCharsets.UTF_8), TextDocument.utf8("hello 🌙"));
    }
}
