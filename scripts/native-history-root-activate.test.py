#!/usr/bin/python3
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest

loader = importlib.machinery.SourceFileLoader('activation', str(Path(__file__).parent.parent / 'deploy/native-history-root-activate'))
spec = importlib.util.spec_from_loader(loader.name, loader)
activation = importlib.util.module_from_spec(spec)
loader.exec_module(activation)


class Tests(unittest.TestCase):
    def test_only_confirmed_matching_candidate_restarts_root(self):
        self.assertTrue(activation.activation_required({'version': 1, 'phase': 'gated', 'candidate': 'b' * 40}, 'b' * 40))
        self.assertFalse(activation.activation_required({'version': 1, 'phase': 'restored', 'candidate': 'a' * 40}, 'b' * 40))
        for phase, candidate in [('gate-pending', 'b' * 40), ('gated', 'a' * 40)]:
            with self.assertRaisesRegex(RuntimeError, 'Unresolved'):
                activation.activation_required({'version': 1, 'phase': phase, 'candidate': candidate}, 'b' * 40)

    def test_ordinary_release_preserves_root_without_candidate_handoff(self):
        source = (Path(__file__).parent.parent / 'deploy/host').read_text()
        self.assertIn('native-history-root-activate', source)
        helper = (Path(__file__).parent.parent / 'deploy/native-history-root-activate').read_text()
        self.assertLess(helper.index('if not journal.exists()'), helper.index("'one-kenan-activate'), 'activate'"))
        self.assertNotIn('pi-kenan-custody.service', helper)
        self.assertNotIn("'systemctl', 'stop'", helper)


if __name__ == '__main__':
    unittest.main()
