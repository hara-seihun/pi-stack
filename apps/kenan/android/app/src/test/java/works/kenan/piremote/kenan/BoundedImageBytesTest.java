package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import org.junit.Test;

public class BoundedImageBytesTest {
    @Test public void oversizedEncoderChunksAreNotRetained() {
        BoundedImageBytes bytes = new BoundedImageBytes(10);
        bytes.write(new byte[] { 1, 2, 3 }, 0, 3);
        bytes.write(new byte[11], 0, 11);
        assertTrue(bytes.exceeded());
        bytes.write(4);
        assertArrayEquals(new byte[] { 1, 2, 3 }, bytes.toByteArray());
    }
    @Test public void exactLimitIsValidUntilAnotherByteArrives() {
        BoundedImageBytes bytes = new BoundedImageBytes(3);
        bytes.write(new byte[] { 1, 2, 3 }, 0, 3);
        assertFalse(bytes.exceeded());
        assertEquals(3, bytes.size());
        bytes.write(4);
        assertTrue(bytes.exceeded());
        assertEquals(3, bytes.size());
    }
}
