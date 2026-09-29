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
    private final Listener listener;
    private volatile boolean running = true;
    private Thread worker;

    WriteOpusRecorder(Listener listener) { this.listener = listener; }
    void start() {
        worker = new Thread(this::run, "write-opus");
        worker.start();
    }
    void stop() { running = false; }

    private void run() {
        AudioRecord input = null;
        MediaCodec encoder = null;
        try {
            if (Build.VERSION.SDK_INT < 29) throw new IOException("Opus recording requires Android 10 or later");
            int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IOException("Microphone unavailable");
            MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 16000, 1);
            format.setInteger(MediaFormat.KEY_BIT_RATE, 24000);
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 640);
            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            encoder.start();
            input = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 3200));
            if (input.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
            input.startRecording();
            byte[] frame = new byte[640];
            int filled = 0;
            long pts = 0;
            int frames = 0;
            while (running) {
                int read = input.read(frame, filled, frame.length - filled, AudioRecord.READ_BLOCKING);
                if (read <= 0) throw new IOException("Microphone read failed: " + read);
                filled += read;
                if (filled < frame.length) continue;
                int slot = encoder.dequeueInputBuffer(1_000_000);
                if (slot < 0) throw new IOException("Opus encoder cannot keep up");
                ByteBuffer buffer = encoder.getInputBuffer(slot);
                if (buffer == null) throw new IOException("Opus encoder input unavailable");
                buffer.clear(); buffer.put(frame);
                encoder.queueInputBuffer(slot, 0, frame.length, pts, 0);
                pts += 20_000;
                if (++frames % 4 == 0) listener.amplitude(amplitude(frame));
                filled = 0;
                drain(encoder, false);
            }
            if (filled > 0) {
                Arrays.fill(frame, filled, frame.length, (byte) 0);
                int slot = encoder.dequeueInputBuffer(1_000_000);
                if (slot < 0) throw new IOException("Opus encoder cannot finish");
                ByteBuffer buffer = encoder.getInputBuffer(slot);
                if (buffer == null) throw new IOException("Opus encoder input unavailable");
                buffer.clear(); buffer.put(frame);
                encoder.queueInputBuffer(slot, 0, frame.length, pts, 0);
                pts += 20_000;
                drain(encoder, false);
            }
            int end = encoder.dequeueInputBuffer(1_000_000);
            if (end < 0) throw new IOException("Opus encoder cannot flush");
            encoder.queueInputBuffer(end, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            drain(encoder, true);
            listener.stopped();
        } catch (IOException | RuntimeException error) {
            listener.failed(error.getMessage() == null ? "Opus recording failed" : error.getMessage());
        } finally {
            if (input != null) {
                try { if (input.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) input.stop(); }
                catch (IllegalStateException ignored) { }
                input.release();
            }
            if (encoder != null) {
                try { encoder.stop(); } catch (IllegalStateException ignored) { }
                encoder.release();
            }
        }
    }

    private void drain(MediaCodec encoder, boolean untilEnd) throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long deadline = android.os.SystemClock.uptimeMillis() + (untilEnd ? 2000 : 0);
        do {
            int index = encoder.dequeueOutputBuffer(info, untilEnd ? 20_000 : 0);
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!untilEnd) return;
                continue;
            }
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
            if (index < 0) throw new IOException("Opus encoder output unavailable");
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                ByteBuffer encoded = encoder.getOutputBuffer(index);
                if (encoded == null) throw new IOException("Opus packet unavailable");
                encoded.position(info.offset);
                encoded.limit(info.offset + info.size);
                byte[] packet = new byte[info.size];
                encoded.get(packet);
                if (!header(packet, "OpusHead") && !header(packet, "OpusTags")) listener.packet(packet);
            }
            boolean ended = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
            encoder.releaseOutputBuffer(index, false);
            if (ended) return;
        } while (!untilEnd || android.os.SystemClock.uptimeMillis() < deadline);
        throw new IOException("Opus encoder flush timed out");
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
