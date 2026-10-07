"""Resident CPU-only greedy cleanup; experimental, not wired to Write."""
from dataclasses import dataclass
import json
from pathlib import Path
from threading import Lock
from time import perf_counter

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MANIFEST = json.loads(Path(__file__).with_name('model.json').read_text())


@dataclass(frozen=True)
class RewriteResult:
    text: str | None
    error: str | None
    latency_ms: float
    generated_tokens: int


class LocalRewriter:
    def __init__(self, cache: Path | None = None):
        cache = cache or Path(MANIFEST['cache'])
        options = ort.SessionOptions()
        options.intra_op_num_threads = MANIFEST['threads']
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        self.session = ort.InferenceSession(str(cache / 'onnx/int8/model.onnx'),
                                            sess_options=options,
                                            providers=['CPUExecutionProvider'])
        self.tokenizer = Tokenizer.from_file(str(cache / 'tokenizer.json'))
        self.lock = Lock()
        self.past_names = [a.name for a in self.session.get_inputs() if a.name.startswith('past_key_values.')]

    def rewrite(self, text: str) -> RewriteResult:
        if '<|im_start|>' in text or '<|im_end|>' in text:
            return RewriteResult(None, 'chat_control_in_input', 0, 0)
        prompt = (f"<|im_start|>system\n{MANIFEST['system_prompt']}<|im_end|>\n"
                  f"<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n")
        ids = self.tokenizer.encode(prompt, add_special_tokens=False).ids
        if len(ids) > MANIFEST['max_prompt_tokens']:
            return RewriteResult(None, 'prompt_too_long', 0, 0)
        start = perf_counter()
        with self.lock:
            try:
                return self._generate(ids, start)
            except Exception as error:
                return RewriteResult(None, f'inference_failed: {error}', (perf_counter() - start) * 1000, 0)

    def _generate(self, ids: list[int], start: float) -> RewriteResult:
        past = {name: np.zeros((1, MANIFEST['kv_heads'], 0, MANIFEST['head_dim']), np.float32)
                for name in self.past_names}
        generated = []
        position = 0
        for _ in range(MANIFEST['max_new_tokens']):
            inputs = dict(past, input_ids=np.array([ids], np.int64),
                          attention_mask=np.ones((1, position + len(ids)), np.int64),
                          position_ids=np.arange(position, position + len(ids), dtype=np.int64)[None])
            outputs = self.session.run(None, inputs)
            token = int(np.argmax(outputs[0][0, -1]))
            position += len(ids)
            if token == MANIFEST['eos_token_id']:
                return RewriteResult(self.tokenizer.decode(generated, skip_special_tokens=True).strip(),
                                     None, (perf_counter() - start) * 1000, len(generated))
            generated.append(token)
            ids = [token]
            past = dict(zip(self.past_names, outputs[1:]))
        return RewriteResult(self.tokenizer.decode(generated, skip_special_tokens=True).strip(),
                             'generation_limit', (perf_counter() - start) * 1000, len(generated))


if __name__ == '__main__':
    import sys
    from dataclasses import asdict
    print(json.dumps(asdict(LocalRewriter().rewrite(' '.join(sys.argv[1:])))))
