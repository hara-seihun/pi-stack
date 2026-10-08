"""CPU English Nemotron transducer; every meeting turn owns independent caches."""
import json
import math
from pathlib import Path

import numpy as np
import onnxruntime as ort

BLANK = 1024
LOG_FLOOR = math.log(2**-24)


class Nemotron:
    def __init__(self, model_dir: Path, threads=4):
        def options(count):
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = count
            opts.add_session_config_entry('session.intra_op.allow_spinning', '0')
            return opts
        model_dir = Path(model_dir)
        self.encoder = ort.InferenceSession(str(model_dir / 'int8/encoder_model.onnx'), sess_options=options(threads), providers=['CPUExecutionProvider'])
        self.decoder = ort.InferenceSession(str(model_dir / 'fp32/decoder_model.onnx'), sess_options=options(1), providers=['CPUExecutionProvider'])
        self.mel = np.fromfile(model_dir / 'shared/filterbank.bin', dtype='<f4').reshape(128, 257)
        self.window = np.pad(np.hanning(400).astype(np.float32), (56, 56))
        self.vocab = {int(line.rsplit(' ', 1)[1]): line.rsplit(' ', 1)[0] for line in (model_dir / 'shared/tokens.txt').read_text().splitlines()}
        self.chunk_frames = json.loads((model_dir / 'config.json').read_text())['encoder']['chunk_mel_frames']
        self.chunk_samples = self.chunk_frames * 160

    def create_stream(self):
        return Stream(self)

    def features(self, audio, first, count):
        x = np.asarray(audio, dtype=np.float32)
        count = min(count, len(x)//160 + 1 - first)
        if count <= 0:
            return np.empty((0, self.mel.shape[0]), np.float32)
        lo, hi = first*160 - 256, (first + count - 1)*160 + 256
        begin, end = max(0, lo), min(len(x), hi)
        emphasised = x[begin:end] - 0.97*(x[begin-1:end-1] if begin > 0 else np.r_[0, x[:end-1]])
        if begin == 0:
            emphasised[0] = x[0]
        window = np.pad(emphasised, (begin - lo, hi - end))
        frames = np.lib.stride_tricks.sliding_window_view(window, 512)[::160]
        power = np.abs(np.fft.rfft(frames*self.window, axis=-1))**2
        return np.log(np.maximum(power @ self.mel.T, 2**-24)).astype(np.float32)


class Stream:
    def __init__(self, model):
        self.model = model
        self.audio = np.empty(0, dtype=np.float32)
        self.samples_decoded = 0
        self.cache_ch = np.zeros((1, 24, 70, 1024), np.float32)
        self.cache_t = np.zeros((1, 24, 1024, 8), np.float32)
        self.cache_n = np.zeros(1, np.int64)
        self.state1 = np.zeros((2, 1, 640), np.float32)
        self.state2 = np.zeros((2, 1, 640), np.float32)
        self.last = BLANK
        self.pieces = []

    def accept(self, samples):
        self.audio = np.concatenate((self.audio, samples))
        while len(self.audio) - self.samples_decoded >= self.model.chunk_samples:
            self._step(self.model.chunk_frames)
            self.samples_decoded += self.model.chunk_samples

    def finish(self, silence_samples=9600):
        self.audio = np.concatenate((self.audio, np.zeros(silence_samples, np.float32)))
        while len(self.audio) > self.samples_decoded:
            self._step(math.ceil(min(len(self.audio)-self.samples_decoded, self.model.chunk_samples) / 160))
            self.samples_decoded += self.model.chunk_samples
        return self.result()

    def _step(self, valid_frames):
        pos = self.samples_decoded // 160
        first = max(0, pos-9)
        features = self.model.features(self.audio[:min(len(self.audio), self.samples_decoded + self.model.chunk_samples)], first, pos + self.model.chunk_frames - first)
        previous = features[:pos-first]
        previous = np.pad(previous, ((9-len(previous), 0), (0, 0)), constant_values=LOG_FLOOR)
        segment = features[pos-first:pos-first+self.model.chunk_frames]
        segment = np.pad(segment, ((0, self.model.chunk_frames-len(segment)), (0, 0)), constant_values=LOG_FLOOR)
        encoded, lengths, self.cache_ch, self.cache_t, self.cache_n = self.model.encoder.run(None, {
            'audio_signal': np.concatenate((previous, segment)).T[None],
            'length': np.array([self.model.chunk_frames+9], np.int64),
            'cache_last_channel': self.cache_ch,
            'cache_last_time': self.cache_t,
            'cache_last_channel_len': self.cache_n,
        })
        for frame in range(min(int(lengths[0]), max(1, math.ceil(valid_frames/8)))):
            for _ in range(10):
                logits, _, next1, next2 = self.model.decoder.run(None, {
                    'encoder_outputs': encoded[:, :, frame:frame+1],
                    'targets': np.array([[self.last]], np.int32),
                    'target_length': np.array([1], np.int32),
                    'input_states_1': self.state1,
                    'input_states_2': self.state2,
                })
                token = int(np.argmax(logits[0, 0, 0]))
                if token == BLANK:
                    break
                self.pieces.append(self.model.vocab[token])
                self.last = token
                self.state1, self.state2 = next1, next2

    def result(self):
        return {'text': ''.join(self.pieces).replace('▁', ' ').strip()}
