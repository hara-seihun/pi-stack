package works.kenan.piremote.kenan;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.os.Build;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Arrays;

/** Captures exact 20 ms PCM frames and emits one unwrapped Opus packet per codec output. */
final class WriteOpusRecorder {
    interface Listener {
        void packet(byte[] packet);
        void amplitude(int level);
        void stopped();
        void failed(String message);
    }
    interface Input extends AutoCloseable {
        void start() throws IOException;
        /** Waits for requested PCM; stop() must unblock a pending read. */
        int read(byte[] frame, int offset, int length) throws IOException;
        void stop();
        void close();
    }
    interface Encoder extends AutoCloseable {
        void start() throws IOException;
        void frame(byte[] frame, long pts) throws IOException;
        void finish(long pts) throws IOException;
        void close();
    }
    interface Resources {
        Input input() throws IOException;
        Encoder encoder(Listener listener) throws IOException;
    }

    private final Listener listener;
    private final Resources resources;
    static final long FINISH_TAIL_MILLIS = 200;
    private volatile boolean running = true;
    private volatile long finishAt;
    private final Object lifecycle = new Object();
    private Thread worker;
    private Input activeInput;
    private RuntimeException stopFailure;
    private final java.util.concurrent.ScheduledExecutorService finishTimer = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();

    WriteOpusRecorder(Listener listener) { this(listener, new NativeResources()); }
    WriteOpusRecorder(Listener listener, Resources resources) {
        this.listener = listener;
        this.resources = resources;
    }
    void start() {
        synchronized (lifecycle) {
            if (worker != null) return;
            worker = new Thread(this::run, "write-opus");
            worker.start();
        }
    }
    void stop() {
        synchronized (lifecycle) {
            if (!running || finishAt != 0) return;
            if (worker == null) running = false;
            else {
                finishAt = System.nanoTime() + FINISH_TAIL_MILLIS * 1_000_000;
                finishTimer.schedule(() -> { synchronized (lifecycle) { stopInput(); lifecycle.notifyAll(); } },
                    FINISH_TAIL_MILLIS, java.util.concurrent.TimeUnit.MILLISECONDS);
            }
            lifecycle.notifyAll();
        }
    }
    void cancel() {
        synchronized (lifecycle) {
            running = false;
            stopInput();
            lifecycle.notifyAll();
        }
    }
    private void stopInput() {
        if (activeInput == null) return;
        try { activeInput.stop(); }
        catch (RuntimeException error) { stopFailure = error; }
        finally { activeInput = null; }
    }

    private void run() {
        Input input = null;
        Encoder encoder = null;
        Exception failure = null;
        try {
            if (!running) return;
            encoder = resources.encoder(listener);
            encoder.start();
            input = resources.input();
            synchronized (lifecycle) {
                if (!running || finishAt != 0) return;
                input.start();
                activeInput = input;
            }
            byte[] frame = new byte[640];
            int filled = 0;
            long pts = 0;
            int frames = 0;
            // AudioRecord.stop() discards unread PCM. Keep reading through the
            // bounded capture-latency tail before stopping the microphone.
            while (running && (finishAt == 0 || System.nanoTime() < finishAt)) {
                int read = input.read(frame, filled, frame.length - filled);
                if (read < 0) {
                    if (!running || finishAt != 0 && System.nanoTime() >= finishAt) break;
                    throw new IOException("Microphone read failed: " + read);
                }
                if (read == 0) {
                    synchronized (lifecycle) {
                        if (running) lifecycle.wait(20);
                    }
                    continue;
                }
                if (!running) break;
                filled += read;
                if (filled < frame.length) continue;
                encoder.frame(frame, pts);
                pts += 20_000;
                if (++frames % 4 == 0) listener.amplitude(amplitude(frame));
                filled = 0;
            }
            synchronized (lifecycle) { stopInput(); }
            if (running) {
                if (filled > 0) {
                    Arrays.fill(frame, filled, frame.length, (byte) 0);
                    encoder.frame(frame, pts);
                    pts += 20_000;
                }
                encoder.finish(pts);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            failure = new IOException("Microphone capture interrupted", error);
        } catch (IOException | RuntimeException error) {
            failure = error;
        } finally {
            finishTimer.shutdownNow();
            synchronized (lifecycle) {
                running = false;
                activeInput = null;
                if (failure == null) failure = stopFailure;
            }
            failure = close(input, failure);
            failure = close(encoder, failure);
            if (failure == null) listener.stopped();
            else listener.failed(failure.getMessage() == null ? "Opus recording failed" : failure.getMessage());
        }
    }

    private static Exception close(AutoCloseable resource, Exception failure) {
        if (resource == null) return failure;
        try { resource.close(); }
        catch (Exception error) {
            if (failure == null) return error;
            if (failure != error) failure.addSuppressed(error);
        }
        return failure;
    }

    // A failed stop must not skip release, and a failed release must reach the recorder's outcome.
    static void release(Runnable stop, Runnable release) {
        RuntimeException failure = null;
        try { stop.run(); }
        catch (RuntimeException error) { failure = error; }
        try { release.run(); }
        catch (RuntimeException error) {
            if (failure == null) failure = error;
            else if (failure != error) failure.addSuppressed(error);
        }
        if (failure != null) throw failure;
    }

    private static final class NativeResources implements Resources {
        public Input input() throws IOException {
            int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IOException("Microphone unavailable");
            AudioRecord record = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 3200));
            return new Input() {
                public void start() throws IOException {
                    if (record.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
                    record.startRecording();
                }
                public int read(byte[] frame, int offset, int length) {
                    return record.read(frame, offset, length, AudioRecord.READ_BLOCKING);
                }
                public void stop() { record.stop(); }
                public void close() {
                    release(() -> {
                        if (record.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) record.stop();
                    }, record::release);
                }
            };
        }
        public Encoder encoder(Listener listener) throws IOException {
            if (Build.VERSION.SDK_INT < 29) throw new IOException("Opus recording requires Android 10 or later");
            return new NativeEncoder(MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS), listener);
        }
    }

    private static final class NativeEncoder implements Encoder {
        private final MediaCodec codec;
        private final Listener listener;
        private boolean started;
        NativeEncoder(MediaCodec codec, Listener listener) { this.codec = codec; this.listener = listener; }
        public void start() {
            MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 16000, 1);
            format.setInteger(MediaFormat.KEY_BIT_RATE, 24000);
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 640);
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            started = true;
        }
        public void frame(byte[] frame, long pts) throws IOException {
            int slot = codec.dequeueInputBuffer(1_000_000);
            if (slot < 0) throw new IOException("Opus encoder cannot keep up");
            ByteBuffer buffer = codec.getInputBuffer(slot);
            if (buffer == null) throw new IOException("Opus encoder input unavailable");
            buffer.clear(); buffer.put(frame);
            codec.queueInputBuffer(slot, 0, frame.length, pts, 0);
            drain(false);
        }
        public void finish(long pts) throws IOException {
            int end = codec.dequeueInputBuffer(1_000_000);
            if (end < 0) throw new IOException("Opus encoder cannot flush");
            codec.queueInputBuffer(end, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            drain(true);
        }
        public void close() { release(() -> { if (started) codec.stop(); }, codec::release); }

        private void drain(boolean untilEnd) throws IOException {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = android.os.SystemClock.uptimeMillis() + (untilEnd ? 2000 : 0);
            do {
                int index = codec.dequeueOutputBuffer(info, untilEnd ? 20_000 : 0);
                if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    if (!untilEnd) return;
                    continue;
                }
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
                if (index < 0) throw new IOException("Opus encoder output unavailable");
                boolean ended = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                try {
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                        ByteBuffer encoded = codec.getOutputBuffer(index);
                        if (encoded == null) throw new IOException("Opus packet unavailable");
                        encoded.limit(info.offset + info.size);
                        encoded.position(info.offset);
                        byte[] packet = new byte[info.size];
                        encoded.get(packet);
                        if (!header(packet, "OpusHead") && !header(packet, "OpusTags")) listener.packet(packet);
                    }
                } finally { codec.releaseOutputBuffer(index, false); }
                if (ended) return;
            } while (!untilEnd || android.os.SystemClock.uptimeMillis() < deadline);
            throw new IOException("Opus encoder flush timed out");
        }
    }

    private static boolean header(byte[] packet, String marker) {
        if (packet.length < marker.length()) return false;
        for (int i = 0; i < marker.length(); i++) if (packet[i] != marker.charAt(i)) return false;
        return true;
    }

    private static int amplitude(byte[] frame) {
        long energy = 0;
        for (int i = 0; i < frame.length; i += 2)
            energy += Math.abs((short) ((frame[i] & 0xff) | (frame[i + 1] << 8)));
        return Math.min(7, (int) (energy / 320 / 1400));
    }
}
