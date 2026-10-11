#!/usr/bin/python3 -B
import sys
sys.dont_write_bytecode = True
from importlib.machinery import SourceFileLoader
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
module = SourceFileLoader('exact_file_bindings_test', str(Path(__file__).resolve().parents[1] / 'deploy/core-bindings')).load_module()

class ExactFiles(unittest.TestCase):
    def test_only_exact_file_alias_extends_to_exact_file(self):
        resources = [{'path':'/home/person', 'kind':'directory'}, {'path':'/home/person/.local/bin/pi', 'kind':'file'}]
        observed = {'/home/person/.local/bin/pi':{'kind':'file','resolvedPath':'/srv/pi/dependencies/exact/stack-pi.mjs','dev':'10','ino':'20'}}
        result, evidence = module.exact_file_targets(resources, observed)
        self.assertEqual(result[-1], {'path':'/srv/pi/dependencies/exact/stack-pi.mjs','kind':'file'})
        self.assertEqual(len(result), 3)
        self.assertEqual(evidence[0]['ino'], '20')
        self.assertEqual(resources[-1]['path'], '/home/person/.local/bin/pi')
        again, _ = module.exact_file_targets(result, {**observed, '/srv/pi/dependencies/exact/stack-pi.mjs':{'kind':'file','resolvedPath':'/srv/pi/dependencies/exact/stack-pi.mjs','dev':'10','ino':'20'}})
        self.assertEqual(again, result)

    def test_directory_alias_never_widens(self):
        resources = [{'path':'/home/person/bin', 'kind':'directory'}]
        self.assertEqual(module.exact_file_targets(resources, {}), (resources, []))

    def test_missing_changed_and_conflicting_target_are_errors(self):
        resources = [{'path':'/home/person/pi','kind':'file'}]
        for info in ({'error':2}, {'kind':'directory'}, {'kind':'file','resolvedPath':'relative','dev':'1','ino':'2'}):
            with self.assertRaises(ValueError): module.exact_file_targets(resources, {'/home/person/pi':info})
        with self.assertRaises(ValueError):
            module.exact_file_targets(resources + [{'path':'/srv/pi/exact','kind':'directory'}], {'/home/person/pi':{'kind':'file','resolvedPath':'/srv/pi/exact','dev':'1','ino':'2'}})

if __name__ == '__main__': unittest.main()
