from importlib.machinery import SourceFileLoader
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
gate = SourceFileLoader('image_handoff_fixture', str(Path(__file__).with_name('core-image-handoff'))).load_module()


class ImageHandoffTests(unittest.TestCase):
    def test_claim_race_terminal_write_and_queue_conservation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.sqlite3'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE inline_images(session_id TEXT,image_id TEXT,value TEXT,PRIMARY KEY(session_id,image_id))')
            for name, state in [('accepted', 'generating'), ('queued', 'queued')]:
                db.execute('INSERT INTO inline_images VALUES(?,?,?)', ('thread', name, json.dumps({'state': state})))
            db.commit()
            s = path.stat(); identity = {'dev': str(s.st_dev), 'ino': str(s.st_ino)}
            self.assertEqual(gate.gate_database(str(path), identity, 'gate', gate.TRIGGERS), {'generating': 1, 'queued': 1})
            # Exact legacy save shape: the raced claim was selected before fencing.
            claim = "INSERT INTO inline_images VALUES(?,?,?) ON CONFLICT(session_id,image_id) DO UPDATE SET value=excluded.value"
            self.assertEqual(db.execute(claim, ('thread', 'queued', '{"state":"generating"}')).rowcount, 0)
            self.assertEqual(db.execute(claim, ('thread', 'accepted', '{"state":"complete"}')).rowcount, 1)
            db.commit()
            self.assertEqual(gate.gate_database(str(path), identity, 'gate', gate.TRIGGERS), {'generating': 0, 'queued': 1})
            gate.gate_database(str(path), identity, 'release', gate.TRIGGERS)
            self.assertEqual(db.execute(claim, ('thread', 'queued', '{"state":"generating"}')).rowcount, 1)
            db.close()

    def test_foreign_trigger_and_replaced_database_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.sqlite3'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE inline_images(value TEXT)')
            db.execute('CREATE TRIGGER pi_core_image_claim_insert BEFORE INSERT ON inline_images BEGIN SELECT RAISE(IGNORE); END')
            db.commit();db.close()
            s = path.stat(); identity = {'dev': str(s.st_dev), 'ino': str(s.st_ino)}
            with self.assertRaises(ValueError):gate.gate_database(str(path), identity, 'gate', gate.TRIGGERS)
            with self.assertRaises(ValueError):gate.gate_database(str(path), {'dev': identity['dev'], 'ino': '1'}, 'gate', gate.TRIGGERS)


if __name__ == '__main__':
    unittest.main()
