"""Cache-aware English Nemotron ONNX transducer; each Session owns independent caches."""

import math
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

BLANK = 1024
LOG_FLOOR = math.log(2**-24)


class Nemotron:
    def __init__(self, model_dir: Path, threads=6):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        model_dir = Path(model_dir)
        self.encoder = ort.InferenceSession(str(model_dir / 'int8/encoder_model.onnx'), sess_options=opts, providers=['CPUExecutionProvider'])
        self.decoder = ort.InferenceSession(str(model_dir / 'fp32/decoder_model.onnx'), sess_options=opts, providers=['CPUExecutionProvider'])
        self.mel = np.fromfile(model_dir / 'shared/filterbank.bin', dtype='<f4').reshape(128, 257)
        self.window = np.pad(np.hanning(400).astype(np.float32), (56, 56))
        self.vocab = {int(line.rsplit(' ', 1)[1]): line.rsplit(' ', 1)[0] for line in (model_dir / 'shared/tokens.txt').read_text().splitlines()}
        self.tokenizer = Tokenizer.from_file(str(model_dir / 'shared/tokenizer.json'))
        self.chunk_frames = json.loads((model_dir / 'config.json').read_text())['encoder']['chunk_mel_frames']
        self.chunk_samples = self.chunk_frames*160

    def create_stream(self, dictionary=None):
        phrases = []
        for text in (dictionary or {}).get('words', []):
            if isinstance(text, str) and text.strip():
                phrases.append(self.tokenizer.encode(text.strip()).ids)
        return Stream(self, phrases)

    def features(self, audio):
        x = np.asarray(audio, dtype=np.float32)
        x = np.r_[x[0], x[1:] - 0.97*x[:-1]]
        x = np.pad(x, 256)
        frames = np.lib.stride_tricks.sliding_window_view(x, 512)[::160]
        power = np.abs(np.fft.rfft(frames*self.window, axis=-1))**2
        return np.log(np.maximum(power@self.mel.T, 2**-24)).astype(np.float32)


class Stream:
    def __init__(self, model, phrases):
        self.model = model
        self.phrases = phrases
        self.ids = []
        self.audio = np.empty(0, dtype=np.float32)
        self.samples_decoded = 0
        self.cache_ch = np.zeros((1, 24, 70, 1024), np.float32)
        self.cache_t = np.zeros((1, 24, 1024, 8), np.float32)
        self.cache_n = np.zeros(1, np.int64)
        self.state1 = np.zeros((2, 1, 640), np.float32)
        self.state2 = np.zeros((2, 1, 640), np.float32)
        self.last = BLANK
        self.pieces = []
        self.token_scores = []
        self.alternative_pieces = []
        self.token_times = []
        self.timings = []

    def accept(self, samples):
        self.audio = np.concatenate((self.audio, samples))
        while len(self.audio) - self.samples_decoded >= self.model.chunk_samples:
            self._step(self.model.chunk_frames)
            self.samples_decoded += self.model.chunk_samples

    def fork(self):
        duplicate = object.__new__(Stream)
        duplicate.model = self.model
        duplicate.phrases = self.phrases
        duplicate.ids = self.ids.copy()
        duplicate.audio = self.audio
        duplicate.samples_decoded = self.samples_decoded
        duplicate.cache_ch = self.cache_ch.copy()
        duplicate.cache_t = self.cache_t.copy()
        duplicate.cache_n = self.cache_n.copy()
        duplicate.state1 = self.state1.copy()
        duplicate.state2 = self.state2.copy()
        duplicate.last = self.last
        duplicate.pieces = self.pieces.copy()
        duplicate.token_scores = self.token_scores.copy()
        duplicate.alternative_pieces = self.alternative_pieces.copy()
        duplicate.token_times = self.token_times.copy()
        duplicate.timings = self.timings.copy()
        return duplicate

    def finish(self, silence_samples=3200):
        if silence_samples:
            self.audio = np.concatenate((self.audio, np.zeros(silence_samples, np.float32)))
        if len(self.audio) > self.samples_decoded:
            while len(self.audio) > self.samples_decoded:
                self._step(math.ceil(min(len(self.audio)-self.samples_decoded, self.model.chunk_samples) / 160))
                self.samples_decoded += self.model.chunk_samples
        return self.result()

    def _step(self, valid_frames):
        began = time.perf_counter()
        features = self.model.features(self.audio[:min(len(self.audio), self.samples_decoded + self.model.chunk_samples)])
        pos = self.samples_decoded // 160
        previous = features[max(0, pos-9):pos]
        previous = np.pad(previous, ((9-len(previous), 0), (0, 0)), constant_values=LOG_FLOOR)
        segment = features[pos:pos+self.model.chunk_frames]
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
                scores = logits[0, 0, 0]
                biased = scores.copy()
                for phrase in self.phrases:
                    for prefix in range(len(phrase)-1, 0, -1):
                        if self.ids[-prefix:] == phrase[:prefix]:
                            biased[phrase[prefix]] += 3.0
                            break
                token = int(np.argmax(biased))
                if token == BLANK:
                    break
                # Exact local joiner alternatives, not a re-ranked phrase lattice.
                best = np.argpartition(scores, -3)[-3:]
                best = sorted(best, key=lambda index: -scores[index])
                probability = np.exp(scores[token] - np.logaddexp.reduce(scores))
                self.ids.append(token)
                self.pieces.append(self.model.vocab.get(token, ''))
                self.token_scores.append(float(probability))
                self.alternative_pieces.append([self.model.vocab.get(int(index), '') for index in best if int(index) != token and int(index) != BLANK])
                self.token_times.append((self.samples_decoded / 16000) + frame*0.08)
                self.last = token
                self.state1, self.state2 = next1, next2
        self.timings.append((time.perf_counter()-began)*1000)

    def result(self):
        words = []
        tokens = []
        def commit():
            if not tokens:
                return
            text = ''.join(self.pieces[i] for i in tokens).replace('▁', ' ').strip()
            conf = math.exp(sum(math.log(max(self.token_scores[i], 1e-9)) for i in tokens)/len(tokens))
            alts = []
            for i in tokens:
                for alternative in self.alternative_pieces[i]:
                    candidate = ''.join(alternative if j == i else self.pieces[j] for j in tokens).replace('▁', ' ').strip()
                    if candidate and ' ' not in candidate and candidate != text and candidate not in alts:
                        alts.append(candidate)
            words.append({'w': text, 'conf': round(conf, 4), 'alts': alts[:3], 'start': round(self.token_times[tokens[0]], 2), 'end': round(self.token_times[tokens[-1]]+0.08, 2)})
        for i, piece in enumerate(self.pieces):
            if piece.startswith('▁') and tokens:
                commit()
                tokens = []
            tokens.append(i)
        commit()
        return {'text': ''.join(self.pieces).replace('▁', ' ').strip(), 'words': words}
