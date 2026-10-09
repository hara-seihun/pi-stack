#!/usr/bin/python3
import importlib.machinery
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

watchdog = importlib.machinery.SourceFileLoader('prompt_availability', str(Path(__file__).resolve().parents[1] / 'deploy/prompt-availability')).load_module()
CANDIDATE = 'a' * 40
LEGACY = 'b' * 40
NOW = 120_000


class AdmissionProof(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name)
        self.receipt = {'version': 1, 'protocol': 'native-history-maintenance-v1', 'uid': os.getuid(),
                        'dataDir': str(self.data), 'candidate': CANDIDATE, 'legacySource': LEGACY,
                        'phase': 'draining', 'admittedAt': 1}
        self.save()
        self.db = sqlite3.connect(self.data / 'threads.sqlite3')
        self.addCleanup(self.db.close)
        self.db.executescript('CREATE TABLE thread_work(id TEXT); CREATE TABLE pi_history_bridge(key TEXT PRIMARY KEY,value TEXT);')
        self.db.execute('INSERT INTO pi_history_bridge VALUES(?,?)', ('identity', json.dumps({'candidate': CANDIDATE, 'legacySource': LEGACY})))
        self.db.commit()

    def save(self):
        (self.data / 'native-history-maintenance.json').write_text(json.dumps(self.receipt))

    def fence(self):
        self.db.executescript("CREATE TRIGGER pi_history_admission BEFORE INSERT ON thread_work BEGIN SELECT RAISE(ABORT,'admission is closed'); END;")

    def inspect(self):
        return watchdog.inspect_owner(str(self.data), CANDIDATE, NOW, 60_000)

    def test_observational_draining_does_not_restore_or_close_admission(self):
        self.receipt['intake'] = 'always-open-v1'
        self.save()
        before = (self.data / 'native-history-maintenance.json').read_bytes()
        self.assertEqual(self.inspect(), {'action': 'none', 'reason': 'admission-open'})
        self.db.execute("INSERT INTO thread_work VALUES('new-agent')")
        self.assertEqual((self.data / 'native-history-maintenance.json').read_bytes(), before)

    def test_phase_or_claim_alone_does_not_override_a_real_fence(self):
        self.receipt['intake'] = 'always-open-v1'
        self.save()
        self.fence()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO thread_work VALUES('new-agent')")
        self.assertEqual(self.inspect(), {'action': 'restore', 'candidate': CANDIDATE})

    def test_own_uid_subprocess_returns_only_bounded_admission_decision(self):
        result = subprocess.run(['/usr/bin/python3', '-B', watchdog.__file__, '--inspect-owner',
                                 str(self.data), CANDIDATE, str(NOW), '60000'],
                                capture_output=True, text=True, check=True, timeout=2)
        self.assertEqual(json.loads(result.stdout), {'action': 'none', 'reason': 'admission-open'})
        self.fence()
        result = subprocess.run(['/usr/bin/python3', '-B', watchdog.__file__, '--inspect-owner',
                                 str(self.data), CANDIDATE, str(NOW), '60000'],
                                capture_output=True, text=True, check=True, timeout=2)
        self.assertEqual(json.loads(result.stdout), {'action': 'restore', 'candidate': CANDIDATE})

    def test_obsolete_draining_phase_without_a_fence_is_not_restoration(self):
        self.assertEqual(self.inspect()['action'], 'none')

    def test_actual_closure_within_budget_waits(self):
        self.fence()
        self.receipt['admittedAt'] = NOW - 59_999
        self.save()
        self.assertEqual(self.inspect()['reason'], 'closure-within-budget')

    def test_crossed_closure_is_not_restored(self):
        self.fence()
        self.db.execute("INSERT INTO pi_history_bridge VALUES('closing','1')")
        self.db.commit()
        self.assertEqual(self.inspect()['reason'], 'closing')
        for phase in ('closing', 'owners-closed', 'migration-pending', 'migrated', 'restored'):
            self.receipt['phase'] = phase
            self.save()
            self.assertEqual(self.inspect()['action'], 'none')

    def test_partial_fence_is_not_invented_closed_admission(self):
        self.db.executescript("CREATE TRIGGER pi_history_children AFTER INSERT ON thread_work BEGIN SELECT 1; END;")
        with self.assertRaisesRegex(ValueError, 'Partial'):
            self.inspect()

    def test_foreign_fence_and_unset_or_unknown_state_are_errors(self):
        self.fence()
        self.db.execute("UPDATE pi_history_bridge SET value=? WHERE key='identity'", (json.dumps({'candidate': 'c' * 40, 'legacySource': LEGACY}),))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.inspect()
        for key, value in (('uid', -1), ('admittedAt', None), ('phase', 'unknown')):
            with self.subTest(key=key):
                prior = self.receipt[key]
                self.receipt[key] = value
                self.save()
                with self.assertRaises(ValueError):
                    self.inspect()
                self.receipt[key] = prior
                self.save()


if __name__ == '__main__':
    unittest.main()
