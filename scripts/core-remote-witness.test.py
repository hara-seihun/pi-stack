#!/usr/bin/env python3
import importlib.machinery
import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

root = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(root/'deploy'))
loader = importlib.machinery.SourceFileLoader('witness', str(root/'deploy/core-remote-witness'))
spec = importlib.util.spec_from_loader(loader.name, loader)
witness = importlib.util.module_from_spec(spec)
loader.exec_module(witness)


class WitnessTests(unittest.TestCase):
    def test_canonical_path_object_reaches_plan_validation(self):
        with patch.object(witness, 'trusted', return_value={'version':1,'unit':'wrong'}):
            with self.assertRaisesRegex(ValueError,'exact Remote unit invocation'):
                witness.plan_at(Path('/root/witness.plan.json'))

    def test_exact_native_child_positive_exit(self):
        text = 'wait4(-1, {WIFEXITED(s) && WEXITSTATUS(s) == 0}, WNOHANG, NULL) = 417\n'
        self.assertEqual(witness.wait4_exit(text,417), {'kind':'normal','code':0})
        with self.assertRaises(ValueError):witness.wait4_exit(text,418)

    def test_child_failure_cannot_be_masked_by_wrapper_exit0(self):
        text = 'wait4(-1, {WIFEXITED(s) && WEXITSTATUS(s) == 1}, WNOHANG, NULL) = 417\n+++ exited with 0 +++\n'
        with self.assertRaises(ValueError):witness.wait4_exit(text,417)
        with self.assertRaises(ValueError):witness.wait4_exit('+++ exited with 0 +++',417)

    def test_signalled_or_conflicting_native_exit_refused(self):
        text = 'wait4(-1, {WIFSIGNALED(s) && WTERMSIG(s) == SIGKILL}, 0, NULL) = 417\n'
        with self.assertRaises(ValueError):witness.wait4_exit(text,417)
        text = 'wait4(-1, {WIFEXITED(s) && WEXITSTATUS(s) == 0}, 0, NULL) = 417\n'
        with self.assertRaises(ValueError):witness.wait4_exit(text+text,417)

    def test_nested_wrapper_binds_exact_unit_owner_and_direct_child(self):
        plan={'unit':'pi-remote@kenan.service','invocationId':'a'*32,'unitOwner':{'pid':10,'startTicks':'100'},'wrapper':{'pid':11,'startTicks':'101'},'nativeChild':{'pid':12,'startTicks':'102'}}
        fields={10:['S','1'],11:['S','10'],12:['S','11']}
        status=Mock(stdout='MainPID=10\nActiveState=active\nInvocationID='+('a'*32)+'\n')
        with patch.object(witness,'birth',side_effect=lambda identity:fields[identity['pid']]),patch.object(witness.os,'readlink',return_value='/usr/local/bin/bun'),patch.object(witness.subprocess,'run',return_value=status):
            witness.verify_live(plan)
            fields[11]=['S','99']
            with self.assertRaisesRegex(ValueError,'exact unit owner'):witness.verify_live(plan)
            fields[11]=['S','10'];fields[12]=['S','99']
            with self.assertRaisesRegex(ValueError,'no longer belongs'):witness.verify_live(plan)
            fields[12]=['S','11'];status.stdout='MainPID=99\nActiveState=active\nInvocationID='+('a'*32)+'\n'
            with self.assertRaisesRegex(ValueError,'invocation changed'):witness.verify_live(plan)

    def test_actual_kernel_wait4_format(self):
        if not Path('/usr/bin/strace').exists():self.skipTest('strace missing')
        with tempfile.TemporaryDirectory() as folder:
            trace = Path(folder)/'wait4.txt'
            result = subprocess.run(['/usr/bin/strace','-qq','-e','trace=wait4','-e','signal=none','-o',str(trace),'/bin/bash','-c','/bin/sleep 0.02 & wait'], capture_output=True,timeout=3)
            self.assertEqual(result.returncode,0,result.stderr)
            text = trace.read_text()
            child = int(re.search(r'WEXITSTATUS\(s\) == 0.*= ([0-9]+)',text)[1])
            self.assertEqual(witness.wait4_exit(text,child),{'kind':'normal','code':0})


if __name__ == '__main__':unittest.main()
