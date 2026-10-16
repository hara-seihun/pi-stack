#!/usr/bin/python3 -B
import sys
sys.dont_write_bytecode=True
from importlib.machinery import SourceFileLoader
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy'))
m=SourceFileLoader('supervised_reconcile',str(Path(__file__).resolve().parents[1]/'deploy/core-supervised-reconcile')).load_module()
class ClosedForwarder(unittest.TestCase):
    def test_only_exact_successful_term_forwarder_is_accepted(self):
        prior={'InvocationID':'old','MainPID':'10'}
        current={'InvocationID':'old','MainPID':'0','ExecMainPID':'10','ActiveState':'inactive','ExecMainCode':'2','ExecMainStatus':'15','Result':'success'}
        self.assertTrue(m.valid_forwarder_exit(current,prior))
        for change in ({'InvocationID':'new'},{'MainPID':'10'},{'ExecMainPID':'11'},{'ActiveState':'active'},{'ExecMainCode':'1'},{'ExecMainStatus':'9'},{'Result':'signal'}):
            self.assertFalse(m.valid_forwarder_exit({**current,**change},prior))
    def test_absence_alone_never_acknowledges_closed_database_owner(self):
        self.assertFalse(m.valid_forwarder_exit({'MainPID':'0','ActiveState':'inactive'},{'InvocationID':'old','MainPID':'10'}))
if __name__=='__main__':unittest.main()
