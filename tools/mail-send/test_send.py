#!/usr/bin/env python3
"""Focused no-network mail boundary checks; --fixture uses the real journal client."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("mail_send", str(Path(__file__).with_name("main")))
spec = importlib.util.spec_from_loader(loader.name, loader)
mail = importlib.util.module_from_spec(spec)
loader.exec_module(mail)

class SMTP:
    sent = []
    error = None
    def __init__(self, *args): pass
    def starttls(self, **kwargs): pass
    def login(self, *args): pass
    def quit(self): pass
    def close(self): pass
    def send_message(self, message):
        if self.error: raise self.error
        self.sent.append(message)
        return {}

def send_fixture():
    with tempfile.TemporaryDirectory() as directory:
        body = Path(directory) / "body.txt"
        body.write_text("Please confirm the foundation schedule with Sybil. Thank you.")
        args = ["mail-send", "--to", "Gaétane <gaetane@example.test>", "--subject", "Foundation schedule", "--body-file", str(body), "--send"]
        with patch.object(sys, "argv", args), patch.object(mail, "creds", return_value=("kenan@example.test", "fixture-only")), patch.object(mail.smtplib, "SMTP", SMTP):
            mail.main()

class BoundaryTests(unittest.TestCase):
    def setUp(self): SMTP.sent = []; SMTP.error = None
    def test_success_logs_accepted_mail_after_dispatch(self):
        events = []
        def journal(command, payload):
            events.append((command, payload, len(SMTP.sent)))
            return {"id": "fixture"} if command == "begin" else {"ok": True}
        with patch.object(mail, "journal_enabled", return_value=True), patch.object(mail, "journal", side_effect=journal): send_fixture()
        self.assertEqual([e[0] for e in events], ["begin", "finish"])
        self.assertEqual([e[2] for e in events], [0, 1])
        self.assertEqual(events[1][1]["outcome"], "confirmed")
        self.assertIn("Gaétane", events[0][1]["recipients"][0])
    def test_journal_intent_failure_prevents_send(self):
        with patch.object(mail, "journal_enabled", return_value=True), patch.object(mail, "journal", side_effect=RuntimeError("disk unavailable")):
            with self.assertRaises(RuntimeError): send_fixture()
        self.assertEqual(len(SMTP.sent), 0)
    def test_confirmed_send_does_not_fail_when_outcome_journal_fails(self):
        def journal(command, payload):
            if command == "finish": raise RuntimeError("disk unavailable")
            return {"id": "fixture"}
        with patch.object(mail, "journal_enabled", return_value=True), patch.object(mail, "journal", side_effect=journal): send_fixture()
        self.assertEqual(len(SMTP.sent), 1)
    def test_flag_off_never_invokes_journal(self):
        with patch.object(mail, "journal_enabled", return_value=False), patch.object(mail, "journal") as journal: send_fixture()
        journal.assert_not_called()
        self.assertEqual(len(SMTP.sent), 1)
    def test_smtp_disconnect_records_unconfirmed(self):
        SMTP.error = mail.smtplib.SMTPServerDisconnected("lost confirmation")
        with patch.object(mail, "journal_enabled", return_value=True), patch.object(mail, "journal", return_value={"id": "fixture"}) as journal:
            with self.assertRaises(mail.smtplib.SMTPServerDisconnected): send_fixture()
        self.assertEqual(journal.call_args.args[1]["outcome"], "unconfirmed")

if __name__ == "__main__":
    if "--fixture" in sys.argv:
        send_fixture()
    else:
        unittest.main()
