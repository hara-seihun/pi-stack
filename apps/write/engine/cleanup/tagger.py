"""Resident ONNX disfluency tagger; initialize once, share across dictations.

Requires onnxruntime, tokenizers and numpy. Model data is supplied separately
at startup; the request path never downloads files or loads weights.
"""
from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Sequence

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


class OnnxDisfluencyTagger:
    MODEL_REVISION = 'e1f59b45e03988dd55b8ff307c602f0d4567bf8c'
    MODEL_SHA256 = 'e8d956f8cd83252e74d970750d3556d70485f27929ef6f50ecb20ac5336a0d3e'

    def __init__(self, directory: str | Path, threads: int = 4):
        path = Path(directory)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(path / 'DisfluencyClassifier.onnx'), sess_options=options,
            providers=['CPUExecutionProvider'])
        self._tokenizer = Tokenizer.from_file(str(path / 'tokenizer.json'))
        self._lock = Lock()

    def predict(self, words: Sequence[str]) -> list[tuple[int, float]]:
        if not words:
            return []
        with self._lock:
            encoding = self._tokenizer.encode(list(words), is_pretokenized=True)
            if len(encoding.ids) > 512:
                raise ValueError('disfluency sentence exceeds 512 model tokens; finalize a sentence earlier')
            ids = np.asarray([encoding.ids], dtype=np.int64)
            logits = self._session.run(None, {
                'input_ids': ids, 'attention_mask': np.ones_like(ids)})[0][0]
        predictions: list[tuple[int, float] | None] = [None] * len(words)
        for index, word_index in enumerate(encoding.word_ids):
            if word_index is None or predictions[word_index] is not None:
                continue
            distribution = logits[index]
            probabilities = np.exp(distribution - np.max(distribution))
            label = int(np.argmax(probabilities))
            predictions[word_index] = (label, float(probabilities[label] / probabilities.sum()))
        if any(prediction is None for prediction in predictions):
            raise ValueError('tagger did not align all source words')
        return [prediction for prediction in predictions if prediction is not None]
