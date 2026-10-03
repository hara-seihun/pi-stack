package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public final class WriteOpusRecorderTest {
    private static void await(CountDownLatch latch) throws InterruptedException {
        assertTrue("Recorder did not settle", latch.await(2, TimeUnit.SECONDS));
    }
    private static final class FakeInput implements WriteOpusRecorder.Input {
        final CountDownLatch reading = new CountDownLatch(1);
        final CountDownLatch stop = new CountDownLatch(1);
        boolean started, closed;
        int reads, stops, partial;
        RuntimeException startError, closeError;
        public void start() { if (startError != null) throw startError; started = true; }
        public int read(byte[] frame, int offset, int length) throws IOException {
            if (reads++ == 0 && partial > 0) {
                java.util.Arrays.fill(frame, offset, offset + partial, (byte) 7);
                return partial;
            }
            reading.countDown();
            try { if (!stop.await(2, TimeUnit.SECONDS)) throw new IOException("Read still blocked"); }
            catch (InterruptedException error) { throw new IOException(error); }
            return -3;
        }
        public void stop() { stops++; stop.countDown(); }
        public void close() { closed = true; stop.countDown(); if (closeError != null) throw closeError; }
    }
    private static final class FakeEncoder implements WriteOpusRecorder.Encoder {
        boolean closed, finished;
        RuntimeException startError, closeError;
        final List<byte[]> frames = new ArrayList<>();
        final List<Long> timestamps = new ArrayList<>();
        long endPts;
        public void start() { if (startError != null) throw startError; }
        public void frame(byte[] frame, long pts) { frames.add(frame.clone()); timestamps.add(pts); }
        public void finish(long pts) { finished = true; endPts = pts; }
        public void close() { closed = true; if (closeError != null) throw closeError; }
    }
    private static final class Capture implements WriteOpusRecorder.Resources, WriteOpusRecorder.Listener {
        final FakeInput input = new FakeInput();
        final FakeEncoder encoder = new FakeEncoder();
        final CountDownLatch done = new CountDownLatch(1);
        int inputAllocations, encoderAllocations, terminals;
        String failure;
        boolean cleanedAtCallback;
        public WriteOpusRecorder.Input input() throws IOException { inputAllocations++; return input; }
        public WriteOpusRecorder.Encoder encoder(WriteOpusRecorder.Listener listener) { encoderAllocations++; return encoder; }
        public void packet(byte[] packet) {}
        public void amplitude(int level) {}
        public void stopped() { terminal(null); }
        public void failed(String message) { terminal(message); }
        private void terminal(String message) {
            failure = message;
            cleanedAtCallback = (inputAllocations == 0 || input.closed) && (encoderAllocations == 0 || encoder.closed);
            terminals++;
            done.countDown();
        }
        WriteOpusRecorder recorder() { return new WriteOpusRecorder(this, this); }
        void settled() throws InterruptedException { await(done); assertTrue(cleanedAtCallback); assertEquals(1, terminals); }
    }

    @Test public void stopUnblocksReadAndReleasesBeforeTerminalCallback() throws Exception {
        Capture capture = new Capture();
        WriteOpusRecorder recorder = capture.recorder();
        recorder.start();
        await(capture.input.reading);
        recorder.stop();
        capture.settled();
        assertNull(capture.failure);
        assertTrue(capture.encoder.finished);
        assertEquals(1, capture.input.stops);
    }

    @Test public void stopPadsPartialFrameAndFlushesIt() throws Exception {
        Capture capture = new Capture();
        capture.input.partial = 100;
        WriteOpusRecorder recorder = capture.recorder();
        recorder.start();
        await(capture.input.reading);
        recorder.stop();
        capture.settled();
        assertNull(capture.failure);
        assertEquals(1, capture.encoder.frames.size());
        byte[] frame = capture.encoder.frames.get(0);
        assertEquals(640, frame.length);
        for (int i = 0; i < frame.length; i++) assertEquals(i < 100 ? 7 : 0, frame[i]);
        assertEquals(Long.valueOf(0), capture.encoder.timestamps.get(0));
        assertEquals(20_000, capture.encoder.endPts);
    }

    @Test public void codecStartupFailureStillReleasesCodec() throws Exception {
        Capture capture = new Capture();
        capture.encoder.startError = new IllegalStateException("Codec configuration failed");
        capture.recorder().start();
        capture.settled();
        assertEquals("Codec configuration failed", capture.failure);
        assertEquals(0, capture.inputAllocations);
    }

    @Test public void microphoneStartupFailureReleasesBothResources() throws Exception {
        Capture capture = new Capture();
        capture.input.startError = new IllegalStateException("Microphone start failed");
        capture.recorder().start();
        capture.settled();
        assertEquals("Microphone start failed", capture.failure);
        assertFalse(capture.encoder.finished);
    }

    @Test public void cleanupFailuresDoNotEscapeOrSkipOtherResource() throws Exception {
        Capture capture = new Capture();
        capture.input.closeError = new IllegalStateException("Microphone release failed");
        capture.encoder.closeError = new IllegalStateException("Codec release failed");
        WriteOpusRecorder recorder = capture.recorder();
        recorder.start();
        await(capture.input.reading);
        recorder.stop();
        capture.settled();
        assertEquals("Microphone release failed", capture.failure);
        assertEquals(1, capture.input.closeError.getSuppressed().length);
    }

    @Test public void nativeStopFailureCannotSkipNativeRelease() {
        IllegalStateException failure = new IllegalStateException("Stop failed");
        boolean[] released = { false };
        assertSame(failure, assertThrows(IllegalStateException.class, () -> WriteOpusRecorder.release(
            () -> { throw failure; }, () -> { released[0] = true; })));
        assertTrue(released[0]);
    }

    @Test public void stopBeforeStartAllocatesNothingAndStartIsOneShot() throws Exception {
        Capture capture = new Capture();
        WriteOpusRecorder recorder = capture.recorder();
        recorder.stop();
        recorder.start();
        capture.settled();
        recorder.start();
        assertEquals(0, capture.inputAllocations);
        assertEquals(0, capture.encoderAllocations);
    }

    @Test public void stopDuringAllocationDoesNotStartMicrophone() throws Exception {
        CountDownLatch allocated = new CountDownLatch(1), resume = new CountDownLatch(1);
        Capture capture = new Capture();
        WriteOpusRecorder recorder = new WriteOpusRecorder(capture, new WriteOpusRecorder.Resources() {
            public WriteOpusRecorder.Encoder encoder(WriteOpusRecorder.Listener listener) { return capture.encoder(listener); }
            public WriteOpusRecorder.Input input() throws IOException {
                allocated.countDown();
                try { if (!resume.await(2, TimeUnit.SECONDS)) throw new IOException("Allocation timed out"); }
                catch (InterruptedException error) { throw new IOException(error); }
                return capture.input();
            }
        });
        recorder.start();
        await(allocated);
        recorder.stop();
        resume.countDown();
        capture.settled();
        assertFalse(capture.input.started);
        assertNull(capture.failure);
    }

    @Test public void repeatedDictationDoesNotRetainResourcesOrStartDuplicateWorkers() throws Exception {
        for (int i = 0; i < 30; i++) {
            Capture capture = new Capture();
            WriteOpusRecorder recorder = capture.recorder();
            recorder.start(); recorder.start();
            await(capture.input.reading);
            recorder.stop(); recorder.stop();
            capture.settled();
            assertNull(capture.failure);
            assertEquals(1, capture.inputAllocations);
            assertEquals(1, capture.encoderAllocations);
        }
    }
}
