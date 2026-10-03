"""Bounded contextual RNN-T search; every hypothesis owns its predictor history."""
from dataclasses import dataclass, replace
import math

import numpy as np


@dataclass(frozen=True)
class Hypothesis:
    ids: tuple
    pieces: tuple
    probabilities: tuple
    alternatives: tuple
    alternative_scores: tuple
    times: tuple
    state1: np.ndarray
    state2: np.ndarray
    last: int
    acoustic: float = 0.0
    text: str = ' '
    confirmed_bonus: float = 0.0


class DictionaryDecoder:
    WIDTH = 8
    GAP = 4.0

    def __init__(self, model, bias, blank):
        self.model, self.bias, self.blank = model, bias, blank
        zero = np.zeros((2, 1, 640), np.float32)
        self.beam = [Hypothesis((), (), (), (), (), (), zero, zero.copy(), blank)]
        self.finished = False
        self.context_words = max((len(phrase.split()) for phrase in bias.phrases), default=1) + 1

    def fork(self):
        duplicate = object.__new__(DictionaryDecoder)
        duplicate.model, duplicate.bias, duplicate.blank = self.model, self.bias, self.blank
        duplicate.beam = self.beam.copy()
        duplicate.finished = self.finished
        duplicate.context_words = self.context_words
        return duplicate

    def rank(self, hypothesis):
        return hypothesis.acoustic + hypothesis.confirmed_bonus + self.bias.potential(hypothesis.text)

    def prune(self, hypotheses):
        # Different alignments of the same token history share predictor state.
        merged = {}
        for hypothesis in hypotheses:
            previous = merged.get(hypothesis.ids)
            if previous is None:
                merged[hypothesis.ids] = hypothesis
            else:
                best = hypothesis if hypothesis.acoustic > previous.acoustic else previous
                merged[hypothesis.ids] = replace(best, acoustic=float(np.logaddexp(
                    hypothesis.acoustic, previous.acoustic)))
        return sorted(merged.values(), key=self.rank, reverse=True)[:self.WIDTH]

    def frame(self, encoded, timestamp):
        active, ended = self.beam, []
        for _ in range(10):
            emitted = []
            for hypothesis in active:
                logits, _, next1, next2 = self.model.decoder.run(None, {
                    'encoder_outputs': encoded,
                    'targets': np.array([[hypothesis.last]], np.int32),
                    'target_length': np.array([1], np.int32),
                    'input_states_1': hypothesis.state1,
                    'input_states_2': hypothesis.state2,
                })
                scores = logits[0, 0, 0]
                log_probabilities = scores - np.logaddexp.reduce(scores)
                primary = int(np.argmax(scores))
                # Ordinary words keep greedy timing. Within a lexical branch,
                # blank competes normally so a name can span acoustic frames
                # rather than greedily consuming residual speech as an extra word.
                contextual = set(self.bias.candidates(hypothesis.text))
                lexical = bool(contextual)
                if primary == self.blank or lexical:
                    ended.append(replace(hypothesis, acoustic=hypothesis.acoustic + float(log_probabilities[self.blank])))
                if primary == self.blank and not contextual:
                    continue
                candidates = {primary} | contextual
                if self.model.vocab.get(primary, '').startswith('▁'):
                    candidates.update(index for index in self.bias.starts
                                      if scores[index] >= scores[primary] - 2.0)
                candidates.discard(self.blank)
                best = np.argpartition(scores, -3)[-3:]
                best = sorted(best, key=lambda index: -scores[index])
                for token in candidates:
                    if scores[token] < scores[primary] - self.GAP:
                        continue
                    alternatives = [int(index) for index in best if index != token and index != self.blank]
                    piece = self.model.vocab.get(token, '')
                    tail, bonus = self.bias.advance(hypothesis.text, piece)
                    emitted.append(Hypothesis(
                        hypothesis.ids + (token,), hypothesis.pieces + (piece,),
                        hypothesis.probabilities + (float(math.exp(log_probabilities[token])),),
                        hypothesis.alternatives + (tuple(self.model.vocab.get(index, '') for index in alternatives),),
                        hypothesis.alternative_scores + (tuple(float(math.exp(log_probabilities[index])) for index in alternatives),),
                        hypothesis.times + (timestamp,), next1, next2, token,
                        hypothesis.acoustic + float(log_probabilities[token]),
                        tail, hypothesis.confirmed_bonus + bonus))
            ended = self.prune(ended)
            active = self.prune(emitted)
            if not active or (len(ended) >= self.WIDTH and self.rank(active[0]) < self.rank(ended[-1])):
                break
        else:
            # Match the greedy decoder's symbol cap: carry the emitted history
            # into the next acoustic frame, without fabricating a blank score.
            ended.extend(active)
        self.beam = self.prune(ended)
        if len(self.beam) > 1:
            best, common = self.visible()
            # Resolve lexical alternatives after bounded right context. Otherwise
            # predictor histories never merge and streaming stalls at the name.
            if sum(piece.startswith('▁') for piece in best.pieces[common:]) > self.context_words:
                self.beam = [best]

    def visible(self):
        best = self.beam[0]
        count = len(best.ids)
        if not self.finished:
            for peer in self.beam[1:]:
                count = min(count, len(peer.ids))
                for index in range(count):
                    if best.ids[index] != peer.ids[index]:
                        count = index
                        break
        return best, count
