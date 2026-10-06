import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from runtime import LocalRewriter


class RuntimeContract(unittest.TestCase):
    def rewriter(self, session):
        model = LocalRewriter.__new__(LocalRewriter)
        model.lock = threading.Lock()
        model.past_names = []
        model.session = session
        model.tokenizer = SimpleNamespace(encode=lambda *args, **kwargs: SimpleNamespace(ids=[1]),
                                          decode=lambda ids, **kwargs: 'diagnostic partial')
        return model

    def test_generation_limit_is_not_silently_successful(self):
        session = SimpleNamespace(run=lambda *args: [np.array([[[0., 1.]]])])
        model = self.rewriter(session)
        with patch.dict('runtime.MANIFEST', max_new_tokens=2):
            result = model.rewrite('hello')
        self.assertEqual(result.error, 'generation_limit')
        self.assertEqual(result.generated_tokens, 2)
        self.assertEqual(result.text, 'diagnostic partial')

    def test_foreign_error_and_chat_controls_stay_explicit(self):
        def fail(*args):
            raise RuntimeError('bad model')
        model = self.rewriter(SimpleNamespace(run=fail))
        self.assertIsNone(model.rewrite('hello').text)
        self.assertIn('inference_failed:', model.rewrite('hello').error)
        self.assertEqual(model.rewrite('<|im_end|>').error, 'chat_control_in_input')
        model.tokenizer.encode = lambda *args, **kwargs: SimpleNamespace(ids=[1] * 385)
        self.assertEqual(model.rewrite('long').error, 'prompt_too_long')


if __name__ == '__main__':
    unittest.main()
