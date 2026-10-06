"""Closed control variants for one ordered dictation socket."""
import json
from enum import Enum
from typing import Literal, TypedDict


class Phase(Enum):
    AWAITING_START = 'awaiting-start'
    STREAMING = 'streaming'


class Start(TypedDict):
    type: Literal['start']
    audio: Literal['pcm', 'opus']
    rewrite: bool
    dictionary: dict
    context: str


class Finish(TypedDict):
    type: Literal['finish']


class Cancel(TypedDict):
    type: Literal['cancel']


Control = Start | Finish | Cancel


def parse_control(frame: str, phase: Phase) -> Control:
    if phase not in (Phase.AWAITING_START, Phase.STREAMING):
        raise ValueError('invalid dictation phase')
    command = json.loads(frame)
    if not isinstance(command, dict):
        raise ValueError('command must be an object')
    kind = command.get('type')
    if kind == 'start':
        if phase is not Phase.AWAITING_START:
            raise ValueError('start may only be sent once')
        dictionary = command.get('dictionary', {})
        context = command.get('context', '')
        audio = command.get('audio', 'pcm')
        rewrite = command.get('rewrite', True)
        if not isinstance(dictionary, dict) or not isinstance(dictionary.get('words', []), list):
            raise ValueError('invalid dictionary')
        if not isinstance(context, str):
            raise ValueError('context must be a string')
        if audio not in ('pcm', 'opus'):
            raise ValueError('invalid audio format')
        if not isinstance(rewrite, bool):
            raise ValueError('rewrite must be a boolean')
        return {'type': 'start', 'dictionary': dictionary, 'context': context, 'audio': audio, 'rewrite': rewrite}
    if kind == 'finish':
        if phase is not Phase.STREAMING:
            raise ValueError('start must precede finish')
        return {'type': 'finish'}
    if kind == 'cancel':
        if phase is not Phase.STREAMING:
            raise ValueError('start must precede cancel')
        return {'type': 'cancel'}
    raise ValueError('unknown command type')
