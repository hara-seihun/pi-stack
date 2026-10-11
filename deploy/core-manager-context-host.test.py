import importlib.util
from pathlib import Path
import shlex
import unittest

spec = importlib.util.spec_from_file_location('context_host', Path(__file__).with_name('core-manager-context-host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class ReciprocalTunnelTests(unittest.TestCase):
    def test_preserves_original_reverse_and_identity(self):
        original = '/usr/bin/ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -R 127.0.0.1:18788:127.0.0.1:18788 converge'
        actual = shlex.split(host.reciprocal_tunnel_command('[Service]\nExecStart=' + original + '\n', 18789))
        expected = shlex.split(original)
        self.assertEqual(actual[:-3] + actual[-1:], expected)
        self.assertEqual(actual[-3:-1], ['-L', '127.0.0.1:18789:127.0.0.1:18789'])

    def test_refuses_unowned_or_ambiguous_transports(self):
        for unit in ['', 'ExecStart=\n', "ExecStart=''\n", 'ExecStart=/bin/ssh -NT -R a converge\n', 'ExecStart=/usr/bin/ssh -NT -R a -L b converge\n', 'ExecStart=/usr/bin/ssh -NT converge\n', 'ExecStart=/usr/bin/ssh -NT -R a converge\nExecStart=/bin/true\n']:
            with self.subTest(unit=unit), self.assertRaises(ValueError):
                host.reciprocal_tunnel_command(unit, 18789)

if __name__ == '__main__':
    unittest.main()
