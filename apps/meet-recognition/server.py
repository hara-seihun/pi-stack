"""Loopback CPU recognition for durably queued external meeting audio."""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

os.environ['OPENBLAS_NUM_THREADS'] = '1'
import numpy as np
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from nemotron import Nemotron
from protocol import Phase, parse_control

LOG = logging.getLogger(__name__)


class Engine:
    MAX_AUDIO_BYTES = 512_000
    FINAL_PADDING = 9600

    def __init__(self, recognizer, streams=4):
        self.recognizer = recognizer
        self.slots = asyncio.Semaphore(streams)

    async def handle(self, socket):
        phase = Phase.AWAITING_START
        stream = None
        received = 0
        work = None
        acquired = False

        async def compute(operation, *args):
            nonlocal work
            work = asyncio.create_task(asyncio.to_thread(operation, *args))
            return await asyncio.shield(work)

        try:
            async with asyncio.timeout(60):
                async for frame in socket:
                    if isinstance(frame, bytes):
                        if phase is not Phase.STREAMING or not frame or len(frame) % 2:
                            await socket.send(json.dumps({'type': 'error', 'message': 'Expected 16 kHz mono PCM16 after start'}))
                            return
                        received += len(frame)
                        if received > self.MAX_AUDIO_BYTES:
                            await socket.send(json.dumps({'type': 'error', 'message': 'Meeting audio exceeds 16 seconds'}))
                            return
                        samples = np.frombuffer(frame, dtype='<i2').astype(np.float32) / 32768
                        await compute(stream.accept, samples)
                        # Every chunk is acknowledged, including silent chunks.
                        await socket.send(json.dumps({'type': 'partial', **stream.result()}))
                        continue
                    parsed = parse_control(frame, phase)
                    if 'error' in parsed:
                        await socket.send(json.dumps({'type': 'error', 'message': parsed['error']}))
                        return
                    command = parsed['value']
                    if command['type'] == 'cancel':
                        return
                    if command['type'] == 'start':
                        await self.slots.acquire()
                        acquired = True
                        stream = self.recognizer.create_stream()
                        phase = Phase.STREAMING
                    elif command['type'] == 'finish':
                        if not received:
                            await socket.send(json.dumps({'type': 'error', 'message': 'Meeting audio is empty'}))
                            return
                        result = await compute(stream.finish, self.FINAL_PADDING)
                        await socket.send(json.dumps({'type': 'final', **result}))
                        return
        except ConnectionClosed:
            pass
        except TimeoutError:
            await socket.send(json.dumps({'type': 'error', 'message': 'Meeting recognition timed out; retry retained audio'}))
        except Exception:
            LOG.exception('Meeting recognition failed')
            await socket.send(json.dumps({'type': 'error', 'message': 'Meeting recognition failed; retry retained audio'}))
        finally:
            # Cancellation cannot release a slot while its native decoder still runs.
            if work is not None and not work.done():
                await asyncio.gather(work, return_exceptions=True)
            if acquired:
                self.slots.release()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--threads', type=int, required=True)
    parser.add_argument('--streams', type=int, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    engine = Engine(Nemotron(args.model, args.threads), args.streams)
    async with serve(engine.handle, args.host, args.port, max_size=64*1024):
        LOG.info('Meet CPU recognition listening at %s:%d', args.host, args.port)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
