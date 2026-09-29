"""Resident joint ONNX tagger, reused across concurrent dictations.

The model has delete, punctuation and capitalization heads. Only the delete
head is applied: the other heads did not improve held-out end-to-end text.
"""
from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Sequence

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


class JointOnnxTagger:
    deletion_threshold = .925

    def __init__(self, directory: str | Path, threads: int = 2):
        path = Path(directory)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(path / 'joint-f32.onnx'), sess_options=options,
            providers=['CPUExecutionProvider'])
        self._tokenizer = Tokenizer.from_file(str(path / 'tokenizer.json'))
        self._lock = Lock()

    def _predict_chunk(self, words: Sequence[str]) -> list[tuple[int, float]]:
        encoding = self._tokenizer.encode(list(words), is_pretokenized=True)
        if len(encoding.ids) > 512:
            half = len(words)//2
            if not half:
                raise ValueError('one spoken word exceeds the 512-token tagger context')
            return self._predict_chunk(words[:half]) + self._predict_chunk(words[half:])
        ids = np.asarray([encoding.ids], dtype=np.int64)
        logits = self._session.run(None, {
            'input_ids': ids, 'attention_mask': np.ones_like(ids)})[0][0]
        predictions: list[tuple[int, float] | None] = [None] * len(words)
        for index, word_index in enumerate(encoding.word_ids):
            if word_index is None or predictions[word_index] is not None:
                continue
            distribution = logits[index]
            probabilities = np.exp(distribution - np.max(distribution))
            probability = float(probabilities[1] / probabilities.sum())
            predictions[word_index] = (1, probability)
        if any(prediction is None for prediction in predictions):
            raise ValueError('joint tagger did not align all source words')
        return [prediction for prediction in predictions if prediction is not None]

    def predict(self, words: Sequence[str]) -> list[tuple[int, float]]:
        if not words:
            return []
        with self._lock:
            return self._predict_chunk(words)
