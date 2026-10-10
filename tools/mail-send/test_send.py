#!/usr/bin/env python3
"""Synthetic SMTP, real isolated ActionStore CLI; never sends network mail."""
import contextlib
import importlib.machinery
import importlib.util
import io
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
CLI = Path(__file__).resolve().parents[2] / "packages/kenan-memory/src/actions-cli.ts"


class SimulatedCrash(BaseException):
    pass


class SMTP:
    sent = []
    attempts = 0
    error = None
    login_error = None
    refused = {}
    def __init__(self, *args, **kwargs): pass
    def starttls(self, **kwargs): pass
    def login(self, *args):
        if self.login_error: raise self.login_error
    def close(self): pass
    def send_message(self, message, **kwargs):
        type(self).attempts += 1
        if self.error and not isinstance(self.error, SimulatedCrash): raise self.error
        self.sent.append(message)
        if self.error: raise self.error
        return self.refused


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        SMTP.sent = []; SMTP.attempts = 0; SMTP.error = None; SMTP.login_error = None; SMTP.refused = {}
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        directory = Path(self.tmp.name)
        self.body = directory / "body.txt"
        self.body.write_text("Please confirm the synthetic schedule. Thank you.")
        config = directory / "host.json"
        config.write_text('{"oneKenan":false}')
        env = {"PATH": os.environ["PATH"], "HOME": str(directory), "USER": "fixture-mail",
               "PI_KENAN_MEMORY_PERSON": "fixture-mail", "PI_KENAN_PERSON": "fixture-mail",
               "PI_KENAN_ACTION_JOURNAL_DIR": str(directory / "actions"), "PI_ACTION_AUTHORITY_LOCAL_FIXTURE": "1",
               "PI_KENAN_ACTION_CLI": str(CLI), "PI_STACK_HOST_CONFIG": str(config)}
        self.enterContext(patch.dict(os.environ, env, clear=True))
        self.enterContext(patch.object(mail, "creds", return_value=("sender@example.test", "synthetic-only")))
        self.enterContext(patch.object(mail.smtplib, "SMTP", SMTP))

    def send(self, *extra, subject="Synthetic schedule"):
        args = ["mail-send", "--to", "Fixture <recipient@example.test>", "--subject", subject,
                "--body-file", str(self.body), "--send", *extra]
        stdout = io.StringIO()
        with patch.object(sys, "argv", args), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            code = mail.main()
        return json.loads(stdout.getvalue().splitlines()[-1]), code

    def test_default_and_explicit_action_cli_use_owned_runtime(self):
        result = mail.subprocess.CompletedProcess([], 0, '{"ok":true,"value":null}', '')
        with patch.dict(os.environ, {}, clear=True), patch.object(mail.subprocess, "run", return_value=result) as run:
            self.assertTrue(mail.action("list", {})["ok"])
            self.assertEqual(run.call_args.args[0], ["bun", "/srv/pi/runtime/node_modules/kenan-memory/src/actions-cli.ts", "list"])
            os.environ["PI_KENAN_ACTION_CLI"] = "/synthetic/actions-cli.ts"
            mail.action("list", {})
            self.assertEqual(run.call_args.args[0][1], "/synthetic/actions-cli.ts")

    def test_mandatory_with_one_kenan_disabled_and_new_request_ids(self):
        first, _ = self.send("--request-id", "first")
        second, _ = self.send("--request-id", "second")
        self.assertEqual(first["value"]["state"], "succeeded")
        self.assertEqual(second["value"]["disposition"], "existing")
        self.assertEqual(len(SMTP.sent), 1)
        action_id = first["value"]["id"]
        self.assertEqual(str(SMTP.sent[0]["Message-ID"]), f"<kenan-action-{action_id}@example.test>")
        self.assertNotIn("Date", first["value"]["payload"])
        self.assertNotIn("Message-ID", first["value"]["payload"])

    def test_rephrased_intent_and_new_uuid_cannot_duplicate_contact(self):
        first, _ = self.send("--canonical-intent", "schedule", "--request-id", "one")
        second, code = self.send("--canonical-intent", "please check date", "--request-id", "two", subject="Different wording")
        self.assertFalse(second["ok"])
        self.assertEqual(code, 2)
        self.assertEqual(second["error"], "fenced")
        self.assertEqual(second["action"]["id"], first["value"]["id"])
        self.assertEqual(second["action"]["state"], "succeeded")
        self.assertIn("resolve-purpose", second["message"])
        self.assertEqual(SMTP.attempts, 1)

    def test_changed_payload_same_intent_is_conflict(self):
        self.send()
        self.body.write_text("A materially different message")
        response, code = self.send()
        self.assertEqual(response["error"], "payload-conflict")
        self.assertEqual(code, 2)
        self.assertEqual(SMTP.attempts, 1)

    def test_authority_failure_prevents_smtp(self):
        with patch.object(mail, "action", return_value={"ok": False, "error": "unavailable", "message": "synthetic disk error"}):
            response, _ = self.send()
        self.assertEqual(response["error"], "unavailable")
        self.assertEqual(SMTP.attempts, 0)

    def test_existing_accepted_can_resume_preparation_but_only_claim_winner_sends(self):
        real_action = mail.action
        def authority(command, payload):
            if command == "claim": return {"ok": False, "error": "unavailable", "message": "synthetic pre-claim interruption"}
            return real_action(command, payload)
        with patch.object(mail, "action", side_effect=authority):
            first, _ = self.send()
        self.assertEqual(first["error"], "unavailable")
        self.assertEqual(SMTP.attempts, 0)
        resumed, _ = self.send("--request-id", "new request after accepted preparation")
        self.assertEqual(resumed["value"]["state"], "succeeded")
        self.assertEqual(SMTP.attempts, 1)

    def test_dispatch_fence_denial_never_enters_smtp_send(self):
        real_action = mail.action
        def authority(command, payload):
            if command == "dispatch": return {"ok": False, "error": "fenced", "message": "synthetic recipient hold"}
            return real_action(command, payload)
        with patch.object(mail, "action", side_effect=authority):
            first, _ = self.send()
        self.assertEqual(first["error"], "fenced")
        self.assertEqual(SMTP.attempts, 0)
        second, _ = self.send()
        self.assertEqual(second["value"]["action"]["state"], "inflight")
        self.assertEqual(SMTP.attempts, 0)

    def test_mime_boundaries_and_dates_do_not_change_attachment_identity(self):
        attachment = Path(self.tmp.name) / "synthetic.bin"
        attachment.write_bytes(b"synthetic attachment")
        self.send("--attach", str(attachment), "--request-id", "one")
        response, _ = self.send("--attach", str(attachment), "--request-id", "two")
        self.assertEqual(response["value"]["disposition"], "existing")
        self.assertEqual(SMTP.attempts, 1)

    def test_projection_failure_before_smtp_releases_slot(self):
        with patch.object(mail, "journal_enabled", return_value=True), \
             patch.object(mail, "journal", side_effect=RuntimeError("synthetic projection failure")):
            response, _ = self.send()
        self.assertEqual(response["value"]["state"], "failed-before-effect")
        self.assertEqual(SMTP.attempts, 0)

    def test_missing_private_directory_refuses_dispatch(self):
        os.environ.pop("PI_KENAN_ACTION_JOURNAL_DIR")
        response, code = self.send()
        self.assertEqual(response["error"], "unavailable")
        self.assertEqual(code, 2)
        self.assertEqual(SMTP.attempts, 0)

    def test_connection_close_failure_does_not_change_acceptance(self):
        with patch.object(SMTP, "close", side_effect=OSError("synthetic cleanup error")):
            response, _ = self.send()
        self.assertEqual(response["value"]["state"], "succeeded")
        self.assertEqual(SMTP.attempts, 1)

    def test_pre_send_failure_releases_recipient_slot_but_not_automatic_retry(self):
        SMTP.login_error = mail.smtplib.SMTPAuthenticationError(535, b"synthetic rejection")
        first, _ = self.send()
        self.assertEqual(first["value"]["state"], "failed-before-effect")
        SMTP.login_error = None
        existing, _ = self.send()
        self.assertEqual(existing["value"]["disposition"], "existing")
        self.assertEqual(SMTP.attempts, 0)
        next_action, _ = self.send("--canonical-intent", "new purpose after known rejection")
        self.assertEqual(next_action["value"]["state"], "succeeded")
        self.assertEqual(SMTP.attempts, 1)

    def test_explicit_smtp_rejection_is_no_effect(self):
        SMTP.error = mail.smtplib.SMTPDataError(554, b"synthetic data rejection")
        response, _ = self.send()
        self.assertEqual(response["value"]["state"], "failed-before-effect")

    def test_disconnect_is_uncertain_and_fences_rephrasing(self):
        SMTP.error = mail.smtplib.SMTPServerDisconnected("lost confirmation")
        first, _ = self.send()
        self.assertEqual(first["value"]["state"], "uncertain")
        SMTP.error = None
        second, code = self.send("--canonical-intent", "rephrased purpose", "--request-id", "new uuid")
        self.assertFalse(second["ok"])
        self.assertEqual(code, 2)
        self.assertEqual(second["error"], "fenced")
        self.assertEqual(second["action"]["id"], first["value"]["id"])
        self.assertEqual(SMTP.attempts, 1)

    def test_crash_after_smtp_remains_inflight(self):
        SMTP.error = SimulatedCrash()
        with self.assertRaises(SimulatedCrash): self.send()
        SMTP.error = None
        response, _ = self.send("--canonical-intent", "fresh words")
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], "fenced")
        self.assertEqual(response["action"]["state"], "inflight")
        self.assertEqual(SMTP.attempts, 1)

    def test_receipt_commit_failure_cannot_replay(self):
        real_action = mail.action
        def authority(command, payload):
            if command == "finish": return {"ok": False, "error": "unavailable", "message": "synthetic receipt failure"}
            return real_action(command, payload)
        with patch.object(mail, "action", side_effect=authority):
            first, code = self.send()
        self.assertEqual(first["error"], "receipt-pending")
        self.assertEqual(code, 2)
        second, _ = self.send()
        self.assertEqual(second["value"]["action"]["state"], "inflight")
        self.assertEqual(SMTP.attempts, 1)

    def test_partial_acceptance_keeps_contact_fence(self):
        SMTP.refused = {"other@example.test": (550, b"synthetic rejection")}
        first, _ = self.send("--cc", "other@example.test")
        self.assertEqual(first["value"]["state"], "succeeded")
        self.assertEqual(first["value"]["result"]["refusedRecipients"], ["other@example.test"])
        self.assertEqual(first["value"]["result"]["acceptedRecipients"], ["recipient@example.test"])
        second, code = self.send("--cc", "other@example.test", subject="Follow up phrased differently")
        self.assertFalse(second["ok"])
        self.assertEqual(code, 2)
        self.assertEqual(second["error"], "fenced")
        self.assertEqual(SMTP.attempts, 1)

    def test_accountable_followup_authorizes_one_new_effect(self):
        first, _ = self.send()
        prior = first["value"]
        flags = ["--canonical-intent", "next scheduling step", "--prior-action", prior["id"],
                 "--prior-revision", str(prior["revision"]), "--prior-resolution", "Synthetic prior purpose resolved"]
        next_action, _ = self.send(*flags, "--request-id", "followup-one")
        self.assertEqual(next_action["value"]["state"], "succeeded")
        self.send(*flags, "--request-id", "followup-two")
        self.assertEqual(SMTP.attempts, 2)

    def test_uncertain_prior_cannot_authorize_followup(self):
        SMTP.error = mail.smtplib.SMTPServerDisconnected("lost confirmation")
        first, _ = self.send()
        prior = first["value"]
        SMTP.error = None
        response, _ = self.send("--canonical-intent", "followup", "--prior-action", prior["id"],
                                "--prior-revision", str(prior["revision"]), "--prior-resolution", "Absence is not proof")
        self.assertEqual(response["error"], "fenced")
        self.assertEqual(SMTP.attempts, 1)

    def test_journal_projection_follows_dispatch(self):
        events = []
        def journal(command, payload):
            events.append((command, payload, len(SMTP.sent)))
            return {"id": "synthetic-journal"} if command == "begin" else {"ok": True}
        with patch.object(mail, "journal_enabled", return_value=True), patch.object(mail, "journal", side_effect=journal):
            response, _ = self.send()
        self.assertEqual(response["value"]["state"], "succeeded")
        self.assertEqual([event[0] for event in events], ["begin", "finish"])
        self.assertEqual([event[2] for event in events], [0, 1])
        self.assertEqual(events[1][1]["outcome"], "confirmed")

    def test_inspect_requires_no_body_or_credentials(self):
        first, _ = self.send()
        with patch.object(sys, "argv", ["mail-send", "--inspect-action", first["value"]["id"]]), \
             contextlib.redirect_stdout(io.StringIO()), patch.object(mail, "creds") as creds:
            self.assertEqual(mail.main(), 0)
        creds.assert_not_called()
        self.assertEqual(SMTP.attempts, 1)


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        sys.argv.remove("--fixture")
    unittest.main()
