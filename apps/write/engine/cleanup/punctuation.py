"""Resident CPU punctuation insertion. Original words and spelling never leave Python."""
from __future__ import annotations

import re
from pathlib import Path
from threading import Lock
from typing import Sequence

import numpy as np
import onnxruntime as ort
from sentencepiece import SentencePieceProcessor

_WORD = re.compile(r"[^\W_]+(?:['’\-][^\W_]+)*", re.UNICODE)
_MARKS = {2: ".", 3: ",", 4: "?"}


class OnnxPunctuator:
    def __init__(self, directory: str | Path, threads: int = 2):
        directory = Path(directory)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        self._session = ort.InferenceSession(
            str(directory / 'punct_cap_seg_en.onnx'), sess_options=options,
            providers=['CPUExecutionProvider'])
        self._tokenizer = SentencePieceProcessor(
            model_file=str(directory / 'spe_32k_lc_en.model'))
        self._lock = Lock()

    def punctuate(self, tokens: Sequence[str]) -> list[str]:
        # Formatting commands delimit separate prose/list items, not one sentence.
        boundaries = [i for i, token in enumerate(tokens)
                      if token.startswith('\n') or token in {'.', '?', '!', ',', ':', ';'}]
        if boundaries:
            result = []
            start = 0
            for end in boundaries:
                result.extend(self._punctuate(tokens[start:end + 1]))
                start = end + 1
            result.extend(self._punctuate(tokens[start:]))
            return result
        return self._punctuate(tokens)

    def _punctuate(self, tokens: Sequence[str]) -> list[str]:
        # Normalize only model input, not the source used to render the answer.
        # Mapping decoded model tokens back to words used to corrupt acronyms,
        # contractions and numbers. Here only marks at source boundaries survive.
        spans = [(index, match) for index, text in enumerate(tokens)
                 for match in _WORD.finditer(text)]
        if not spans:
            return list(tokens)
        final_word_end = {index: match.end() for index, match in spans}
        normalized = ' '.join(match.group().lower() for _, match in spans)
        ends = {}
        position = 0
        for index, match in spans:
            position += len(match.group().lower().encode('utf-8'))
            ends[position] = (index, match)
            position += 1
        with self._lock:
            encoding = self._tokenizer.encode(normalized, return_type='proto')
            pieces = list(encoding.pieces)
            predictions = {}
            # 256 positions, including BOS/EOS, with 16-token context overlap.
            for start in range(0, len(pieces), 222):
                lo, hi = max(0, start - 16), min(len(pieces), start + 238)
                ids = [self._tokenizer.bos_id()] + [p.id for p in pieces[lo:hi]] + [self._tokenizer.eos_id()]
                post = self._session.run(['post_preds'], {
                    'input_ids': np.asarray([ids], dtype=np.int64)})[0][0]
                for i in range(start, min(start + 222, len(pieces))):
                    end = pieces[i].end
                    if end in ends:
                        predictions[end] = _MARKS.get(int(post[i - lo + 1]), '')
        insertions: dict[int, list[tuple[int, str]]] = {}
        for end, mark in predictions.items():
            if not mark:
                continue
            index, match = ends[end]
            if match.end() != final_word_end[index]:
                continue
            suffix = tokens[index][match.end():]
            # Never insert inside an identifier, URL, path, decimal or acronym.
            if suffix and not suffix[0].isspace() and suffix[0] not in '.,?!:;)]}\"':
                continue
            if any(character in tokens[index] for character in '/\\@_`'):
                continue
            # Explicit ASR/spoken punctuation takes precedence over inference.
            if suffix.lstrip().startswith(tuple('.,?!:;')):
                continue
            if not suffix.strip() and index + 1 < len(tokens):
                following = tokens[index + 1].lstrip()
                if following.startswith(tuple('.,?!:;\n')) or tokens[index + 1].startswith('\n'):
                    continue
            insertions.setdefault(index, []).append((match.end(), mark))
        result = list(tokens)
        for index, additions in insertions.items():
            for offset, mark in sorted(additions, reverse=True):
                result[index] = result[index][:offset] + mark + result[index][offset:]
        return result
