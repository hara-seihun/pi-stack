"""Decode one raw Android Opus packet per binary WebSocket frame to mono 16 kHz PCM."""
import struct

import av
import numpy as np


class OpusDecoder:
    def __init__(self):
        # Android MediaCodec sends raw packets, not Ogg or OpusHead. The FFmpeg
        # decoder needs its stream parameters supplied here, inside the server.
        self.codec = av.CodecContext.create('opus', 'r')
        self.codec.extradata = b'OpusHead' + bytes((1, 1)) + struct.pack('<HIhB', 0, 16000, 0, 0)
        self.codec.open()
        self.resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        self.first = True

    def decode(self, packet: bytes) -> np.ndarray:
        if not 1 <= len(packet) <= 1500:
            raise ValueError('invalid Opus packet length')
        try:
            frames = self.codec.decode(av.Packet(packet))
            if len(frames) != 1 or frames[0].sample_rate != 48000 or frames[0].samples != 960:
                raise ValueError('expected one 20 ms mono Opus packet')
            resampled = self.resampler.resample(frames[0])
            samples = np.concatenate([frame.to_ndarray().reshape(-1) for frame in resampled])
        except av.FFmpegError as error:
            raise ValueError('invalid Opus packet') from error
        # FFmpeg's 48-to-16 kHz resampler has a 16-sample startup delay. Pad
        # at the beginning rather than flushing those samples only after ✓:
        # a finish must remain eligible for the already computed speculative
        # final. This shifts audio by 1 ms and omits at most 1 ms at the end.
        if self.first:
            samples = np.pad(samples, (16, 0))
            self.first = False
        if samples.size != 320:
            raise ValueError('invalid decoded Opus frame duration')
        return samples.astype(np.float32) / 32768
