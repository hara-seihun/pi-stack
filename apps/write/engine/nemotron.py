"""Cache-aware English Nemotron ONNX transducer; each Session owns independent caches."""

import math
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
from gpu_encoder import maybe_load
from dictionary import PhraseBias
from dictionary_decoder import DictionaryDecoder

BLANK = 1024
LOG_FLOOR = math.log(2**-24)


class Nemotron:
    def __init__(self, model_dir: Path, threads=6, enable_gpu=True):
        def options(count):
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = count
            # ORT's pool otherwise busy-waits between runs: the idle service held
            # 2.8 cores and competed with the very steps it was waiting for.
            opts.add_session_config_entry('session.intra_op.allow_spinning', '0')
            return opts
        model_dir = Path(model_dir)
        self.encoder = ort.InferenceSession(str(model_dir / 'int8/encoder_model.onnx'), sess_options=options(threads), providers=['CPUExecutionProvider'])
        # The joint/prediction network runs once per emitted token on a 1x1 input;
        # extra threads only add wake-up latency.
        self.decoder = ort.InferenceSession(str(model_dir / 'fp32/decoder_model.onnx'), sess_options=options(1), providers=['CPUExecutionProvider'])
        self.mel = np.fromfile(model_dir / 'shared/filterbank.bin', dtype='<f4').reshape(128, 257)
        self.window = np.pad(np.hanning(400).astype(np.float32), (56, 56))
        self.vocab = {int(line.rsplit(' ', 1)[1]): line.rsplit(' ', 1)[0] for line in (model_dir / 'shared/tokens.txt').read_text().splitlines()}
        self.tokenizer = Tokenizer.from_file(str(model_dir / 'shared/tokenizer.json'))
        self.chunk_frames = json.loads((model_dir / 'config.json').read_text())['encoder']['chunk_mel_frames']
        self.chunk_samples = self.chunk_frames*160
        self.gpu = maybe_load(Path(__file__).resolve().parent / 'gpu-model') if enable_gpu else None

    def create_stream(self, dictionary=None):
        dictionary = dictionary or {}
        phrases = list(dictionary.get('words', []))
        phrases.extend(rule['from'] for rule in dictionary.get('replacements', [])
                       if isinstance(rule, dict) and isinstance(rule.get('from'), str)
                       and isinstance(rule.get('to'), str) and rule['to'].strip())
        return Stream(self, PhraseBias(self.vocab, phrases))

    def features(self, audio, first=0, count=None):
        """Log-mel frames [first, first+count) of `audio`, identical to slicing the
        full-signal features. Frame k covers pre-emphasised samples k*160-256 ..
        k*160+256 of the zero-padded signal, so only that window is transformed;
        recomputing the whole utterance per chunk made each step grow with its length."""
        x = np.asarray(audio, dtype=np.float32)
        total = len(x)//160 + 1
        count = total - first if count is None else min(count, total - first)
        if count <= 0:
            return np.empty((0, self.mel.shape[0]), np.float32)
        lo = first*160 - 256
        hi = (first + count - 1)*160 + 256
        begin, end = max(0, lo), min(len(x), hi)
        emphasised = x[begin:end] - 0.97*(x[begin-1:end-1] if begin > 0 else np.r_[0, x[:end-1]])
        if begin == 0:
            emphasised[0] = x[0]
        window = np.pad(emphasised, (begin - lo, hi - end))
        frames = np.lib.stride_tricks.sliding_window_view(window, 512)[::160]
        power = np.abs(np.fft.rfft(frames*self.window, axis=-1))**2
        mel = power@self.mel.T
        # The native Transformers frontend adds the guard before log; the ONNX
        # export clamps at the guard. Keep each encoder's training frontend.
        return np.log(mel + 2**-24 if self.gpu else np.maximum(mel, 2**-24)).astype(np.float32)


class Stream:
    def __init__(self, model, phrases):
        self.model = model
        self.phrases = phrases
        self.dictionary_decoder = DictionaryDecoder(model, phrases, BLANK) if phrases.phrases else None
        self.ids = []
        self.audio = np.empty(0, dtype=np.float32)
        self.samples_decoded = 0
        self.cache_ch = np.zeros((1, 24, 70, 1024), np.float32)
        self.cache_t = np.zeros((1, 24, 1024, 8), np.float32)
        self.cache_n = np.zeros(1, np.int64)
        self.gpu_cache = None
        self.gpu_padding = None
        self.is_speculative = False
        self.state1 = np.zeros((2, 1, 640), np.float32)
        self.state2 = np.zeros((2, 1, 640), np.float32)
        self.last = BLANK
        self.pieces = []
        self.token_scores = []
        self.alternative_pieces = []
        self.alternative_scores = []
        self.token_times = []
        self.timings = []
        self.stage_timings = []

    def accept(self, samples):
        self.audio = np.concatenate((self.audio, samples))
        while len(self.audio) - self.samples_decoded >= self.model.chunk_samples:
            # A GPU call has a fixed launch overhead. If a congested decoder
            # has accumulated audio, encode up to four chunks in one call.
            chunks = min(4, (len(self.audio) - self.samples_decoded) // self.model.chunk_samples) if self.model.gpu else 1
            self._step(chunks * self.model.chunk_frames)
            self.samples_decoded += chunks * self.model.chunk_samples

    def fork(self):
        duplicate = object.__new__(Stream)
        duplicate.model = self.model
        duplicate.phrases = self.phrases
        duplicate.dictionary_decoder = self.dictionary_decoder.fork() if self.dictionary_decoder else None
        duplicate.ids = self.ids.copy()
        duplicate.audio = self.audio
        duplicate.samples_decoded = self.samples_decoded
        duplicate.cache_ch = self.cache_ch.copy()
        duplicate.cache_t = self.cache_t.copy()
        duplicate.cache_n = self.cache_n.copy()
        duplicate.gpu_cache = self.model.gpu.fork(self.gpu_cache) if self.model.gpu else None
        duplicate.gpu_padding = self.model.gpu.fork(self.gpu_padding) if self.model.gpu else None
        duplicate.is_speculative = True
        duplicate.state1 = self.state1.copy()
        duplicate.state2 = self.state2.copy()
        duplicate.last = self.last
        duplicate.pieces = self.pieces.copy()
        duplicate.token_scores = self.token_scores.copy()
        duplicate.alternative_pieces = self.alternative_pieces.copy()
        duplicate.alternative_scores = self.alternative_scores.copy()
        duplicate.token_times = self.token_times.copy()
        duplicate.timings = self.timings.copy()
        duplicate.stage_timings = self.stage_timings.copy()
        return duplicate

    def finish(self, silence_samples=9600):
        if silence_samples:
            self.audio = np.concatenate((self.audio, np.zeros(silence_samples, np.float32)))
        if len(self.audio) > self.samples_decoded:
            while len(self.audio) > self.samples_decoded:
                chunks = min(4, math.ceil((len(self.audio)-self.samples_decoded)/self.model.chunk_samples)) if self.model.gpu else 1
                self._step(math.ceil(min(len(self.audio)-self.samples_decoded, chunks*self.model.chunk_samples) / 160))
                self.samples_decoded += chunks * self.model.chunk_samples
        if self.dictionary_decoder:
            self.dictionary_decoder.finished = True
            self._dictionary_visible()
        return self.result()

    def _dictionary_visible(self):
        hypothesis, count = self.dictionary_decoder.visible()
        self.ids = list(hypothesis.ids[:count])
        self.pieces = list(hypothesis.pieces[:count])
        self.token_scores = list(hypothesis.probabilities[:count])
        self.alternative_pieces = list(hypothesis.alternatives[:count])
        self.alternative_scores = list(hypothesis.alternative_scores[:count])
        self.token_times = list(hypothesis.times[:count])

    def _step(self, valid_frames):
        began = time.perf_counter()
        pos = self.samples_decoded // 160
        first = max(0, pos-9)
        step_frames = (math.ceil(valid_frames / self.model.chunk_frames) * self.model.chunk_frames
                       if self.model.gpu else self.model.chunk_frames)
        features = self.model.features(self.audio[:min(len(self.audio), self.samples_decoded + step_frames*160)],
                                       first, pos + step_frames - first)
        previous = features[:pos-first]
        previous = np.pad(previous, ((9-len(previous), 0), (0, 0)), constant_values=LOG_FLOOR)
        segment = features[pos-first:pos-first+step_frames]
        segment = np.pad(segment, ((0, step_frames-len(segment)), (0, 0)), constant_values=LOG_FLOOR)
        feature_ms = (time.perf_counter()-began)*1000
        if self.model.gpu:
            encoded, self.gpu_cache, self.gpu_padding, gpu_metrics = self.model.gpu.step(
                segment, self.gpu_cache, self.gpu_padding, speculative=self.is_speculative)
            lengths = (encoded.shape[-1],)
        else:
            encoded, lengths, self.cache_ch, self.cache_t, self.cache_n = self.model.encoder.run(None, {
                'audio_signal': np.concatenate((previous, segment)).T[None],
                'length': np.array([self.model.chunk_frames+9], np.int64),
                'cache_last_channel': self.cache_ch,
                'cache_last_time': self.cache_t,
                'cache_last_channel_len': self.cache_n,
            })
        encoded_at = time.perf_counter()
        for frame in range(min(int(lengths[0]), max(1, math.ceil(valid_frames/8)))):
            if self.dictionary_decoder:
                self.dictionary_decoder.frame(encoded[:, :, frame:frame+1],
                                              self.samples_decoded / 16000 + frame * .08)
                continue
            for _ in range(10):
                logits, _, next1, next2 = self.model.decoder.run(None, {
                    'encoder_outputs': encoded[:, :, frame:frame+1],
                    'targets': np.array([[self.last]], np.int32),
                    'target_length': np.array([1], np.int32),
                    'input_states_1': self.state1,
                    'input_states_2': self.state2,
                })
                scores = logits[0, 0, 0]
                token = int(np.argmax(scores))
                if token == BLANK:
                    break
                # Exact local joiner alternatives, not a re-ranked phrase lattice.
                best = np.argpartition(scores, -3)[-3:]
                best = sorted(best, key=lambda index: -scores[index])
                normalizer = np.logaddexp.reduce(scores)
                probability = np.exp(scores[token] - normalizer)
                alternatives = [int(index) for index in best if int(index) != token and int(index) != BLANK]
                self.ids.append(token)
                self.pieces.append(self.model.vocab.get(token, ''))
                self.token_scores.append(float(probability))
                self.alternative_pieces.append([self.model.vocab.get(index, '') for index in alternatives])
                self.alternative_scores.append([float(np.exp(scores[index] - normalizer)) for index in alternatives])
                self.token_times.append((self.samples_decoded / 16000) + frame*0.08)
                self.last = token
                self.state1, self.state2 = next1, next2
        if self.dictionary_decoder:
            self._dictionary_visible()
        completed = time.perf_counter()
        self.timings.append((completed-began)*1000)
        self.stage_timings.append({'featureMs': feature_ms,
                                   'gpuWaitMs': gpu_metrics[0] if self.model.gpu else 0,
                                   'gpuEncodeMs': gpu_metrics[1] if self.model.gpu else 0,
                                   'jointMs': (completed-encoded_at)*1000,
                                   'frames': step_frames})

    def result(self):
        words = []
        tokens = []
        def commit():
            if not tokens:
                return
            text = ''.join(self.pieces[i] for i in tokens).replace('▁', ' ').strip()
            log_support = sum(math.log(max(self.token_scores[i], 1e-9)) for i in tokens)
            conf = math.exp(log_support / len(tokens))
            alternatives = {}
            for i in tokens:
                for alternative, probability in zip(self.alternative_pieces[i], self.alternative_scores[i]):
                    candidate = ''.join(alternative if j == i else self.pieces[j] for j in tokens).replace('▁', ' ').strip()
                    if candidate and ' ' not in candidate and candidate != text:
                        support = math.exp((log_support - math.log(max(self.token_scores[i], 1e-9))
                                            + math.log(max(probability, 1e-9))) / len(tokens))
                        alternatives[candidate] = max(alternatives.get(candidate, 0), support)
            alts = [{'w': candidate, 'conf': round(support, 4)} for candidate, support in
                    sorted(alternatives.items(), key=lambda item: (-item[1], item[0]))[:3]]
            words.append({'w': text, 'conf': round(conf, 4), 'alts': alts, 'start': round(self.token_times[tokens[0]], 2), 'end': round(self.token_times[tokens[-1]]+0.08, 2)})
        for i, piece in enumerate(self.pieces):
            if piece.startswith('▁') and tokens:
                commit()
                tokens = []
            tokens.append(i)
        commit()
        return {'text': ''.join(self.pieces).replace('▁', ' ').strip(), 'words': words}
