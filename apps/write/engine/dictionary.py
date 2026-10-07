"""Segmentation-independent lexical context for the transducer joiner.

Bonuses are bounded log-score preferences, not probabilities. An unfinished
prefix loses its bonus on divergence; repeated subwords cannot accumulate it.
"""
from functools import lru_cache


class PhraseBias:
    def __init__(self, vocabulary, words, budget=6.0):
        self.budget = budget
        self.continuations = {}
        self.phrases = tuple(sorted({' ' + ' '.join(word.split()).casefold() for word in words
                                   if isinstance(word, str) and word.strip()}))
        pieces = [(index, piece.replace('▁', ' ').casefold())
                  for index, piece in vocabulary.items() if piece]
        self.starts = tuple(index for index, piece in pieces if piece.startswith(' ')
                            and any(phrase.startswith(piece) for phrase in self.phrases))
        self.max_length = max(map(len, self.phrases), default=0)
        for phrase in self.phrases:
            # No initiation bonus. Two letters must already be recognized at
            # a word boundary before context supplies continuation candidates.
            for length in range(3, len(phrase)):
                prefix, remaining = phrase[:length], phrase[length:]
                compatible = self.continuations.setdefault(prefix, set())
                compatible.update(index for index, piece in pieces
                                  if remaining.startswith(piece))
        self.continuations = {prefix: tuple(sorted(ids))
                              for prefix, ids in self.continuations.items() if ids}
        self.candidates = lru_cache(maxsize=256)(self.candidates)
        self.potential = lru_cache(maxsize=256)(self.potential)

    def candidates(self, text):
        tail = text[-self.max_length:]
        ids = set()
        for start, character in enumerate(tail):
            if character == ' ':
                ids.update(self.continuations.get(tail[start:], ()))
        return tuple(sorted(ids))

    def at_completion(self, text):
        return any(text.endswith(phrase) for phrase in self.phrases)

    def advance(self, text, piece):
        fragment = piece.replace('▁', ' ').casefold()
        confirmed = (self.budget if self.at_completion(text) and fragment
                     and not (fragment[0].isalnum() or fragment[0] in '_-') else 0.0)
        return (text + fragment)[-self.max_length:], confirmed

    def potential(self, text):
        if self.at_completion(text):
            return self.budget
        if self.candidates(text):
            return min(2.0, self.budget)
        return 0.0
