from importlib.machinery import SourceFileLoader
from pathlib import Path
import sys
import unittest
import subprocess
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
drain = SourceFileLoader('core_drain_test', str(Path(__file__).resolve().parents[1] / 'deploy/core-drain')).load_module()


class DetachmentEvidence(unittest.TestCase):
    def test_journal_accepts_timezone_aware_drain_boundary(self):
        since = drain.journal_since('2026-10-10T23:35:40.186884+00:00')
        result = subprocess.run(['/usr/bin/journalctl','--no-pager','-n','0','--since',since],capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,0,result.stderr)
        with self.assertRaises(ValueError):drain.journal_since('2026-10-10T23:35:40.186884')

    def test_only_exact_successful_original_exit_is_a_detachment(self):
        prior = {'MainPID': '42', 'InvocationID': 'original'}
        current = {'MainPID': '0', 'ExecMainPID': '42', 'InvocationID': '', 'ActiveState': 'inactive', 'ExecMainCode': '1', 'ExecMainStatus': '0', 'Result': 'success'}
        drain.detached_status(current, prior, 'remote', None)
        for update in [{'ExecMainCode': '2'}, {'Result': 'timeout'}, {'ExecMainPID': '43'}, {'InvocationID': 'replacement'}, {'MainPID': '43'}]:
            with self.assertRaises(ValueError):
                drain.detached_status({**current, **update}, prior, 'remote', None)
        with self.assertRaises(ValueError):
            drain.detached_status(current, prior, 'fleet', None)
        with self.assertRaises(ValueError):
            drain.detached_status(current, prior, 'fleet', {'state': 'retained', 'edges': [{'state': 'retained'}]})
        drain.detached_status(current, prior, 'fleet', {'state': 'closed', 'edges': [{'state': 'closed'}]})


if __name__ == '__main__':
    unittest.main()
