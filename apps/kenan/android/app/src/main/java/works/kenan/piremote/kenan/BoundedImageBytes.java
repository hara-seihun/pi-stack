package works.kenan.piremote.kenan;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

final class BoundedImageBytes extends ByteArrayOutputStream {
    private final int limit;
    private boolean exceeded;
    BoundedImageBytes(int limit) {
        super(Math.min(32768, limit));
        if (limit <= 0) throw new IllegalArgumentException("Image byte limit must be positive");
        this.limit = limit;
    }
    boolean exceeded() { return exceeded; }
    @Override public synchronized void write(int value) {
        if (exceeded || count == limit) { exceeded = true; return; }
        grow(count + 1);
        buf[count++] = (byte) value;
    }
    @Override public synchronized void write(byte[] bytes, int offset, int length) {
        java.util.Objects.checkFromIndexSize(offset, length, bytes.length);
        if (exceeded || length > limit - count) { exceeded = true; return; }
        grow(count + length);
        System.arraycopy(bytes, offset, buf, count, length);
        count += length;
    }
    private void grow(int size) {
        if (size > buf.length) buf = Arrays.copyOf(buf, Math.min(limit, Math.max(size, buf.length * 2)));
    }
}
