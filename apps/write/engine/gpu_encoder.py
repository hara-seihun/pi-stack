"""Native cache-aware Nemotron encoder on ROCm; CPU RNNT joint stays in ONNX.

The model's pinned Transformers implementation accepts exactly 16 mel frames per
160 ms step and emits two 1024-wide encoder frames. Its DynamicCache and causal
convolution padding cache are independent for each dictation and its forks.
"""

import copy
import logging
import os
from pathlib import Path
import time
import threading

import numpy as np

LOG = logging.getLogger(__name__)


class GpuEncoder:
    def __init__(self, directory: Path):
        # The module is installed by the host's gpu-jobs NixOS configuration.
        import sys
        sys.path.insert(0, '/run/current-system/sw/share/gpu-job')
        import gpu_job
        # The checkpoint and ROCm libraries occupy ~6 GiB host RSS at steady
        # state; reserve 8 GiB including startup and concurrent cache growth.
        result = gpu_job.acquire_secondary(host_bytes=8 * 1024**3, gtt_bytes=2 * 1024**3)
        if not isinstance(result, gpu_job.Held):
            raise RuntimeError(f'GPU residency denied: {result}')
        # Delay heavy imports and allocations until after admission. The lock
        # descriptor remains in gpu_job's module state for this process lifetime.
        try:
            import torch
            from transformers import NemotronAsrStreamingForRNNT
            if not torch.cuda.is_available():
                raise RuntimeError('ROCm device unavailable')
            self.torch = torch
            self.gate = threading.Condition()
            self.running = False
            self.waiting_live = 0
            self.model = NemotronAsrStreamingForRNNT.from_pretrained(
                str(directory), local_files_only=True, low_cpu_mem_usage=True,
                torch_dtype=torch.float16).eval().to('cuda')
            # ROCm initializes kernels lazily. Paying that cost on the first
            # dictation once caused a 4.3-second finalization backlog.
            silent = np.full((16, 128), np.log(2**-24), np.float32)
            cache = padding = None
            for _ in range(4):
                _, cache, padding, _ = self.step(silent, cache, padding)
            for chunks in (2, 3, 4):
                self.step(np.tile(silent, (chunks, 1)), cache, padding)
            LOG.info('Write native GPU encoder warmed, allocatedMiB=%.0f',
                     torch.cuda.memory_allocated() / 1024**2)
        except BaseException:
            gpu_job.release_secondary()
            raise

    @staticmethod
    def fork(cache):
        return copy.deepcopy(cache) if cache is not None else None

    def step(self, mel, cache, padding, *, speculative=False):
        # Several concurrent tiny GEMVs interfere catastrophically on the
        # iGPU. Run exactly one encoder step at a time; queued live audio takes
        # precedence over a disposable speculative final.
        queued = time.perf_counter()
        with self.gate:
            if not speculative:
                self.waiting_live += 1
            try:
                while self.running or (speculative and self.waiting_live):
                    self.gate.wait()
                self.running = True
            finally:
                if not speculative:
                    self.waiting_live -= 1
        try:
            torch = self.torch
            began = time.perf_counter()
            wait_ms = (began - queued)*1000
            with torch.inference_mode():
                x = torch.as_tensor(np.ascontiguousarray(mel[None]), device='cuda', dtype=torch.float16)
                out = self.model.encoder(x, past_key_values=cache,
                                         padding_cache=padding, use_cache=True,
                                         num_lookahead_tokens=1)
                encoded = out.last_hidden_state.float().cpu().numpy().transpose(0, 2, 1)
            elapsed = (time.perf_counter() - began)*1000
            if elapsed > 100:
                LOG.warning('Write GPU encoder slow step melFrames=%d elapsedMs=%.1f', len(mel), elapsed)
            return encoded, out.past_key_values, out.padding_cache, (round(wait_ms, 2), round(elapsed, 2))
        finally:
            with self.gate:
                self.running = False
                self.gate.notify_all()


def maybe_load(directory):
    if os.getenv('PI_STACK_WRITE_DEVICE', 'cpu') not in ('auto', 'gpu'):
        return None
    if not directory or not Path(directory, 'model.safetensors').is_file():
        LOG.warning('Write GPU weights not prepared; using CPU encoder')
        return None
    try:
        return GpuEncoder(Path(directory))
    except Exception:
        LOG.exception('Write GPU initialization failed; using CPU encoder')
        return None
