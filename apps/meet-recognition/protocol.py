"""Recognition accepts one PCM16 meeting turn, not arbitrary product controls."""
import json
from enum import Enum


class Phase(Enum):
    AWAITING_START = 'awaiting-start'
    STREAMING = 'streaming'


def parse_control(frame, phase):
    try:
        command = json.loads(frame)
    except (json.JSONDecodeError, TypeError):
        return {'error': 'Invalid recognition JSON'}
    if not isinstance(command, dict):
        return {'error': 'Recognition command must be an object'}
    if command == {'type': 'cancel'}:
        return {'value': command}
    if phase is Phase.AWAITING_START:
        if set(command) == {'type', 'turn'} and command['type'] == 'start' and isinstance(command['turn'], str) and 0 < len(command['turn']) <= 200:
            return {'value': command}
        return {'error': 'Expected start with a meeting turn id'}
    if phase is Phase.STREAMING and command == {'type': 'finish'}:
        return {'value': command}
    return {'error': 'Invalid recognition command sequence'}
