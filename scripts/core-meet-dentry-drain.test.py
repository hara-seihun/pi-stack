#!/usr/bin/python3 -B
import sys
sys.dont_write_bytecode = True
from importlib.machinery import SourceFileLoader
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy'))
module=SourceFileLoader('meet_dentry_test',str(Path(__file__).resolve().parents[1]/'deploy/core-meet-dentry-drain')).load_module()
class Proofs(unittest.TestCase):
    def test_normal_kernel_exit_requires_both_positive_tokens(self):
        self.assertTrue(module.normal_exit('exit_group(0) = ?\n+++ exited with 0 +++\n'))
        for text in ('','+++ exited with 0 +++','exit_group(0) = ?','exit_group(2) = ?\n+++ exited with 2 +++'):
            self.assertFalse(module.normal_exit(text))
    def test_closed_channel_never_reopens_common_path(self):
        class Closed:
            def request(self,*args,**kwargs):self.connect()
        with self.assertRaisesRegex(ValueError,'no pathname reconnect'):
            module.response(Closed(),'GET','/runtime/status')
if __name__=='__main__':unittest.main()
