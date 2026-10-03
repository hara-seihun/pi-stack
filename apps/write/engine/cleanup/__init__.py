"""Bounded, provenance-preserving cleanup for English streaming dictation.

The source words, rather than a language model's vocabulary, define the content
vocabulary. No network, model loading or global mutable state is on the hot path.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Protocol, Sequence

_FILLERS = {"um", "uh", "erm", "er", "ah", "hmm"}
_REPAIR = {"sorry", "rather"}
_ONES = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
         "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
         "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
         "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
         "eighteen": 18, "nineteen": 19}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
         "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_NUMBERS = _ONES | _TENS
_END = {".", "?", "!"}
_COMMANDS = {("new", "line"): "\n", ("new", "paragraph"): "\n\n",
             ("bullet", "point"): "\n- ", ("question", "mark"): "?",
             ("exclamation", "mark"): "!"}
_SINGLE_COMMANDS = {"comma": ",", "period": ".", "fullstop": ".", "colon": ":"}
_QUOTE_OPEN = {('open', 'quote'), ('start', 'quote'), ('begin', 'quote')}
_QUOTE_CLOSE = {('close', 'quote'), ('end', 'quote'), ('un', 'quote')}
_SPEECH_VERBS = {'said', 'says', 'asked', 'replied', 'shouted', 'whispered', 'wrote'}
_SPEAKERS = {'i', 'he', 'she', 'they', 'you', 'we', 'someone', 'kenan',
             'sign', 'message', 'email', 'text', 'note', 'button', 'label', 'error'}
_DIRECT_START = {"i", "i'm", "i'll", "i've", "i'd", "we're", "we'll", "we've",
                 'hello', 'hi', 'hey', 'goodbye', 'welcome', 'sorry', 'okay', 'ok',
                 'thanks', 'thank', 'yes', 'no', 'please',
                 "let's", 'go', 'stop', 'come', 'leave', 'wait', 'listen', 'look',
                 'try', 'send', 'call', 'do', "don't", 'can', 'could', 'would',
                 'will', 'are', 'is', 'have', 'did', 'does'}


def _bare(word: str) -> str:
    return re.sub(r"[^\w'-]", "", word).lower()


def _word(item: Mapping[str, Any] | str) -> str:
    return item if isinstance(item, str) else str(item.get("w", ""))


def _literal_indices(words: Sequence[str], context: str) -> set[int]:
    literal: set[int] = set()
    explicit_open = context.count('“') > context.count('”') or context.count('"') % 2 == 1
    for index, word in enumerate(words):
        if explicit_open or any(mark in word for mark in '“”"'):
            literal.add(index)
        for mark in word:
            if mark == '“':
                explicit_open = True
            elif mark == '”':
                explicit_open = False
            elif mark == '"':
                explicit_open = not explicit_open
    return literal


def _quotation_controls(words: Sequence[str], context: str) -> tuple[dict[int, tuple[int, str]], set[int]]:
    bare = [_bare(word) for word in words]
    commands: dict[int, tuple[int, str]] = {}
    literal = _literal_indices(words, context)
    opened = context.count('“') > context.count('”')
    i = 0
    while i < len(bare):
        pair = tuple(bare[i:i+2])
        count, mark = 0, ''
        if pair in _QUOTE_OPEN:
            count, mark = 2, '“'
        elif pair in _QUOTE_CLOSE:
            count, mark = 2, '”'
        elif bare[i] == 'unquote' and opened:
            count, mark = 1, '”'
        elif bare[i] == 'quote' and not opened and any(
                bare[k] == 'unquote' or tuple(bare[k:k+2]) in _QUOTE_CLOSE
                for k in range(i + 1, len(bare))):
            count, mark = 1, '“'
        if count:
            commands[i] = (count, mark)
            opened = mark == '“'
            i += count
        else:
            if opened:
                literal.add(i)
            i += 1
    return commands, literal


def _probability(item: Mapping[str, Any] | str) -> float | None:
    value = item.get("conf") if isinstance(item, Mapping) else None
    try:
        probability = float(value)
    except (TypeError, ValueError):
        return None
    return probability if math.isfinite(probability) and 0 <= probability <= 1 else None


def _conf(item: Mapping[str, Any] | str) -> float:
    probability = _probability(item)
    return probability if probability is not None else 1.0


class WordTagger(Protocol):
    def predict(self, words: Sequence[str]) -> Sequence[tuple[int, float]]: ...


class Punctuator(Protocol):
    def punctuate(self, tokens: Sequence[str]) -> Sequence[str]: ...


@dataclass(frozen=True)
class _Token:
    text: str
    start: int
    end: int


def _replace_dictionary(tokens: list[_Token], dictionary: Mapping[str, Any]) -> tuple[list[_Token], list[dict]]:
    rules = []
    for rule in dictionary.get("replacements", []):
        if isinstance(rule, Mapping) and rule.get("from") and rule.get("to"):
            src = [_bare(w) for w in str(rule["from"]).split()]
            rules.append((src, str(rule["to"])))
    rules.sort(key=lambda r: -len(r[0]))
    result: list[_Token] = []
    edits: list[dict] = []
    i = 0
    while i < len(tokens):
        match = next(((src, dst) for src, dst in rules
                      if [_bare(t.text) for t in tokens[i:i+len(src)]] == src), None)
        if match:
            src, dst = match
            chunk = tokens[i:i+len(src)]
            result.append(_Token(dst, chunk[0].start, chunk[-1].end))
            edits.append({"kind": "substitute", "from": " ".join(t.text for t in chunk),
                          "to": dst, "at": [chunk[0].start, chunk[-1].end]})
            i += len(src)
        else:
            result.append(tokens[i]); i += 1
    return result, edits


def _direct_speech_start(tokens: list[_Token], start: int) -> bool:
    first = _bare(tokens[start].text)
    if first in _DIRECT_START:
        return True
    if first not in {'what', 'which', 'where', 'when', 'why', 'how', 'who'}:
        return False
    before_subject = {'i', 'you', 'he', 'she', 'they', 'we', 'it', 'the', 'a', 'an'}
    auxiliaries = {'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can',
                   'could', 'will', 'would', 'should', 'has', 'have'}
    for token in tokens[start + 1:start + 4]:
        bare = _bare(token.text)
        if bare in before_subject:
            return False
        if bare in auxiliaries:
            return True
    return False


def _infer_quotations(tokens: list[_Token]) -> tuple[list[_Token], list[dict]]:
    # Indirect speech and uncertain boundaries stay unquoted. The punctuation
    # model has no quotation label: these explicit linguistic cues own inference.
    if any(any(mark in token.text for mark in '“”"') for token in tokens):
        return tokens, []
    result: list[_Token] = []
    edits: list[dict] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        speaker = tokens[i - 1].text if i else ''
        direct = (i > 0 and i + 1 < len(tokens) and _bare(token.text) in _SPEECH_VERBS
                  and not token.text.endswith(tuple(_END))
                  and (_bare(speaker) in _SPEAKERS or speaker[:1].isupper())
                  and _direct_speech_start(tokens, i + 1))
        if not direct:
            result.append(token)
            i += 1
            continue
        end = i + 1
        while end + 1 < len(tokens) and not tokens[end].text.endswith(tuple(_END)):
            end += 1
        # A following narrative clause is not evidence of what was said verbatim.
        if any((_bare(tokens[k].text), _bare(tokens[k + 1].text)) == ('and', 'then')
               for k in range(i + 1, end)):
            result.append(token)
            i += 1
            continue
        verb = token.text if token.text.endswith((',', ':')) else token.text + ','
        if verb != token.text:
            edits.append({'kind': 'format', 'from': token.text, 'to': verb,
                          'at': [token.start, token.end]})
        result.extend([_Token(verb, token.start, token.end),
                       _Token('“', tokens[i + 1].start, tokens[i + 1].start)])
        for quoted in tokens[i + 1:end + 1]:
            result.append(quoted)
        result.append(_Token('”', tokens[end].end, tokens[end].end))
        edits.extend([{'kind': 'insert', 'from': '', 'to': '“',
                       'at': [tokens[i + 1].start, tokens[i + 1].start]},
                      {'kind': 'insert', 'from': '', 'to': '”',
                       'at': [tokens[end].end, tokens[end].end]}])
        i = end + 1
    return result, edits


def _number(tokens: list[_Token], i: int) -> tuple[str, int] | None:
    a = _bare(tokens[i].text)
    if a in _TENS and i+1 < len(tokens) and _bare(tokens[i+1].text) in _ONES:
        b = _bare(tokens[i+1].text)
        if _ONES[b] < 10:
            return str(_TENS[a] + _ONES[b]), 2
    # Single spoken number is left in prose. Multiword numerals are unambiguous.
    return None


def _format(tokens: list[_Token], context: str) -> tuple[str, list[dict]]:
    if not tokens:
        return "", []
    text = ""
    edits: list[dict] = []
    cap = not context or context.rstrip().rstrip('”"').endswith(tuple(_END))
    for idx, token in enumerate(tokens):
        if token.text in {"\n", "\n\n", "\n- "}:
            text = text.rstrip() + token.text
            cap = True
            continue
        word = token.text.strip()
        if not word:
            continue
        if word.lower() == "i":
            word = "I"
        if cap and word[0].isalpha():
            word = word[0].upper() + word[1:]
        if word != token.text:
            edits.append({"kind": "format", "from": token.text, "to": word,
                          "at": [token.start, token.end]})
        if word in _END and text.endswith(('”', '"')):
            terminal = text.rstrip('”"')
            if terminal.endswith(tuple(_END)):
                edits.append({'kind': 'delete', 'from': word, 'to': '',
                              'at': [token.start, token.end]})
            else:
                text = terminal + word + text[len(terminal):]
            cap = True
            continue
        if text and not word.startswith(tuple(".,!?;:)]}”")) and not text.endswith(tuple("([{“\n ")):
            text += " "
        text += word
        if word == '“':
            cap = cap or (idx > 0 and _bare(tokens[idx - 1].text) in _SPEECH_VERBS)
        else:
            cap = text.rstrip('”"').endswith(tuple(_END))
    terminal = text.rstrip('”"')
    if terminal and terminal[-1] not in ".?!,:;":
        literal_close = tokens[-1].text.endswith(('”', '"')) and tokens[-1].text not in {'”', '"'}
        text = text + "." if literal_close else terminal + "." + text[len(terminal):]
        edits.append({"kind": "insert", "from": "", "to": ".",
                      "at": [tokens[-1].end, tokens[-1].end]})
    return text, edits


def clean(words: Sequence[Mapping[str, Any] | str],
          dictionary: Mapping[str, Any] | None = None,
          context: str = "",
          tagger: WordTagger | None = None,
          punctuator: Punctuator | None = None) -> dict[str, Any]:
    """Clean committed ASR words; edits use half-open source word indices.

    Alternatives are accepted only when they match a dictionary word and the
    primary has low confidence. A replacement rule is explicit user authority.
    Hesitation and correction markers are deleted; content is otherwise copied.
    """
    dictionary = dictionary or {}
    allowed = {_bare(str(w)) for w in dictionary.get("words", [])}
    tokens: list[_Token] = []
    edits: list[dict] = []
    quote_controls, quoted = _quotation_controls([_word(item) for item in words], context)
    quote_indices = {i for start, (count, _) in quote_controls.items()
                     for i in range(start, start + count)}
    predictions = tagger.predict([_word(item) for item in words]) if tagger else None
    if predictions is not None and len(predictions) != len(words):
        raise ValueError('tagger must return one prediction per source word')
    for i, item in enumerate(words):
        raw = _word(item).strip()
        if not raw:
            continue
        if predictions is not None:
            label, probability = predictions[i]
            protected = (i in quoted or i in quote_indices or
                         _bare(raw) in allowed or _bare(raw) in _NUMBERS or
                         _bare(raw) in {"no", "not", "never", "nothing"} or
                         any(character.isdigit() for character in raw))
            if (label in (1, 2, 3, 4) and
                    probability >= getattr(tagger, 'deletion_threshold', .95) and not protected):
                edits.append({"kind": "delete", "from": raw, "to": "", "at": [i, i+1]})
                continue
        candidate = raw
        if isinstance(item, Mapping) and _conf(item) < .78:
            alternatives = item.get("alts", [])
            ranked = [a for a in alternatives if isinstance(a, Mapping)
                      and _probability(a) is not None]
            selected = next((a for a in sorted(ranked, key=lambda a: -_conf(a))
                             if _bare(str(a.get("w", ""))) in allowed
                             and _bare(str(a.get("w", ""))) != _bare(raw)
                             and _conf(a) >= _conf(item) - .12), None)
            if selected:
                candidate = str(selected["w"])
                edits.append({"kind": "substitute", "from": raw, "to": candidate, "at": [i, i+1]})
        tokens.append(_Token(candidate, i, i+1))

    kept: list[_Token] = []
    j = 0
    while j < len(tokens):
        token = tokens[j]
        bare = _bare(token.text)
        quote_command = quote_controls.get(token.start)
        if quote_command:
            count, mark = quote_command
            chunk = tokens[j:j+count]
            kept.append(_Token(mark, chunk[0].start, chunk[-1].end))
            edits.append({'kind': 'format', 'from': ' '.join(t.text for t in chunk),
                          'to': mark, 'at': [chunk[0].start, chunk[-1].end]})
            j += count
            continue
        phrase = tuple(_bare(t.text) for t in tokens[j:j+2])
        command = _COMMANDS.get(phrase)
        count = 2
        if not command and bare in _SINGLE_COMMANDS and kept:
            command = _SINGLE_COMMANDS[bare]
            count = 1
        if command:
            chunk = tokens[j:j+count]
            kept.append(_Token(command, chunk[0].start, chunk[-1].end))
            edits.append({'kind': 'format', 'from': ' '.join(t.text for t in chunk),
                          'to': command, 'at': [chunk[0].start, chunk[-1].end]})
            j += count
            continue
        if token.start in quoted:
            kept.append(token)
            j += 1
            continue
        if bare in _FILLERS or (token.text.startswith("[") and token.text.endswith("]")):
            edits.append({"kind": "delete", "from": token.text, "to": "", "at": [token.start, token.end]})
            j += 1; continue
        marker_length = (2 if bare == "wait" and j+1 < len(tokens)
                         and _bare(tokens[j+1].text) == "no" else
                         2 if bare == "i" and j+1 < len(tokens)
                         and _bare(tokens[j+1].text) == "mean"
                         and kept and not kept[-1].text.endswith(tuple(".,?!:;"))
                         and not tokens[j+1].text.endswith(tuple(".,?!:;")) else
                         1 if bare in _REPAIR and j+1 < len(tokens)
                         and _bare(tokens[j+1].text) not in {"for", "about", "to"}
                         and (not kept or _bare(kept[-1].text) not in {"i'm", "am"}) else 0)
        # Standalone 'no' is a correction only when the following phrase
        # restarts an earlier determiner; otherwise it may be the intended word.
        restart = (bare == "no" and j+1 < len(tokens) and
                   _bare(tokens[j+1].text) in {"the", "a", "an"} and
                   any(_bare(t.text) == _bare(tokens[j+1].text) for t in kept[-5:]))
        if restart:
            marker_length = 1
        if marker_length and j+marker_length < len(tokens) and kept:
            drop = 1
            if restart:
                drop = next((k for k in range(1, min(6, len(kept)+1))
                             if _bare(kept[-k].text) == _bare(tokens[j+1].text)), 1)
            for removed in kept[-drop:]:
                edits.append({"kind": "delete", "from": removed.text, "to": "",
                              "at": [removed.start, removed.end]})
            del kept[-drop:]
            chunk = tokens[j:j+marker_length]
            edits.append({"kind": "delete", "from": " ".join(t.text for t in chunk),
                          "to": "", "at": [chunk[0].start, chunk[-1].end]})
            j += marker_length; continue
        if (j+3 < len(tokens) and
            [_bare(t.text) for t in tokens[j:j+2]] ==
            [_bare(t.text) for t in tokens[j+2:j+4]]):
            chunk = tokens[j:j+2]
            for t in chunk:
                edits.append({"kind": "delete", "from": t.text, "to": "", "at": [t.start, t.end]})
            j += 2; continue
        if kept and bare == _bare(kept[-1].text) and bare not in {"that", "had", "not", "no"}:
            edits.append({"kind": "delete", "from": token.text, "to": "", "at": [token.start, token.end]})
            j += 1; continue
        number = _number(tokens, j)
        if number:
            value, count = number
            chunk = tokens[j:j+count]
            kept.append(_Token(value, chunk[0].start, chunk[-1].end))
            edits.append({"kind": "format", "from": " ".join(t.text for t in chunk),
                          "to": value, "at": [chunk[0].start, chunk[-1].end]})
            j += count; continue
        kept.append(token); j += 1
    kept, replacements = _replace_dictionary(kept, dictionary)
    edits.extend(replacements)
    if punctuator and kept:
        punctuated = punctuator.punctuate([token.text for token in kept])
        if len(punctuated) != len(kept):
            raise ValueError('punctuator must return one output per source token')
        restored = []
        literal_source = _literal_indices([_word(item) for item in words], context)
        literal = {index for index, token in enumerate(kept) if token.start in literal_source}
        for index, (token, text) in enumerate(zip(kept, punctuated)):
            if index in literal:
                text = token.text
            if text != token.text:
                edits.append({'kind': 'format', 'from': token.text, 'to': text,
                              'at': [token.start, token.end]})
            restored.append(_Token(text, token.start, token.end))
        kept = restored
    kept, quotations = _infer_quotations(kept)
    edits.extend(quotations)
    text, formatting = _format(kept, context)
    edits.extend(formatting)
    edits.sort(key=lambda edit: (edit["at"][0], edit["at"][1], edit["kind"]))
    return {"text": text, "edits": edits}


class IncrementalCleaner:
    """Per-dictation session: finalize only a stable prefix, revisit the last 12 words.

    `update` accepts newly committed words; `finish` accepts any final tail.
    Completed source sentences older than the lookbehind become immutable;
    an unfinished sentence stays live for repairs across chunk edges.
    A client must treat partial text as provisional until final.
    """
    def __init__(self, dictionary: Mapping[str, Any] | None = None, context: str = "",
                 lookbehind: int = 12, tagger: WordTagger | None = None,
                 punctuator: Punctuator | None = None):
        self.dictionary = dictionary or {}
        self.context = context
        self.lookbehind = lookbehind
        self.tagger = tagger
        self.punctuator = punctuator
        self._prefix = ""
        self._pending: list[Mapping[str, Any] | str] = []
        self._consumed = 0
        self._edits: list[dict] = []

    def update(self, committed: Sequence[Mapping[str, Any] | str]) -> dict[str, Any]:
        self._pending.extend(committed)
        if len(self._pending) > self.lookbehind * 2:
            limit = len(self._pending) - self.lookbehind
            controls, quoted = _quotation_controls([_word(item) for item in self._pending],
                                                    self.context + self._prefix)
            unresolved = {i for i, item in enumerate(self._pending)
                          if _bare(_word(item)) == 'quote' and i not in controls
                          and not any(start <= i < start + count
                                      for start, (count, _) in controls.items())}
            n = max((i+1 for i, item in enumerate(self._pending[:limit])
                     if _word(item).rstrip().endswith(tuple(_END)) and i not in quoted
                     and not any(start <= i for start in unresolved)), default=0)
            if n:
                stable = clean(self._pending[:n], self.dictionary, self.context + self._prefix,
                               self.tagger, self.punctuator)
                self._prefix += stable["text"] + " "
                self._edits.extend(_shift_edits(stable["edits"], self._consumed))
                self._consumed += n
                del self._pending[:n]
        result = clean(self._pending, self.dictionary, self.context + self._prefix,
                       self.tagger, self.punctuator)
        edits = self._edits + _shift_edits(result["edits"], self._consumed)
        edits.sort(key=lambda edit: (edit["at"][0], edit["at"][1], edit["kind"]))
        return {"text": self._prefix + result["text"], "edits": edits}

    def fork(self) -> "IncrementalCleaner":
        """An independent copy at this point, for speculative finals."""
        duplicate = IncrementalCleaner(self.dictionary, self.context, self.lookbehind,
                                       self.tagger, self.punctuator)
        duplicate._prefix = self._prefix
        duplicate._pending = list(self._pending)
        duplicate._consumed = self._consumed
        duplicate._edits = list(self._edits)
        return duplicate

    def finish(self, tail: Sequence[Mapping[str, Any] | str] = ()) -> dict[str, Any]:
        result = self.update(tail)
        self._pending.clear()
        self._prefix = result["text"]
        self._edits = result["edits"]
        return result


def _shift_edits(edits: list[dict], offset: int) -> list[dict]:
    return [dict(e, at=[i+offset for i in e["at"]]) for e in edits]
