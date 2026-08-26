package dev.piremote;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.Test;

public class ContextSyncTest {
    @Test public void verifiedSpliceReproducesDocument() throws Exception {
        String base = "{\"text\":\"before moon after\"}";
        String target = "{\"text\":\"before moon and stars after\"}";
        byte[] left = base.getBytes(StandardCharsets.UTF_8);
        byte[] right = target.getBytes(StandardCharsets.UTF_8);
        int prefix = 0;
        while (prefix < left.length && prefix < right.length && left[prefix] == right[prefix]) prefix++;
        int suffix = 0;
        while (suffix < left.length - prefix && suffix < right.length - prefix
            && left[left.length - 1 - suffix] == right[right.length - 1 - suffix]) suffix++;
        String inserted = Base64.getEncoder().encodeToString(java.util.Arrays.copyOfRange(right, prefix, right.length - suffix));
        ContextSync.Document result = ContextSync.splice(new ContextSync.Document(base, ContextSync.hash(base), 1), 2,
            ContextSync.hash(base), ContextSync.hash(target), prefix, left.length - prefix - suffix, inserted);
        assertEquals(target, result.json);
    }

    @Test public void damagedSpliceIsRejected() throws Exception {
        String base = "one";
        assertThrows(IllegalStateException.class, () -> ContextSync.splice(
            new ContextSync.Document(base, ContextSync.hash(base), 1), 2, ContextSync.hash(base), ContextSync.hash("two"),
            0, 3, Base64.getEncoder().encodeToString("bad".getBytes(StandardCharsets.UTF_8))));
    }
}
