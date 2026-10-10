"""Identity failures remain explicit; all source mutations use temporary copies."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("public_identity", BASE / "identity.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class IdentityContracts(unittest.TestCase):
    def test_adopted_bytes_and_retained_check_receipt_match(self):
        self.assertTrue(identity.inspect("source", None)["ok"])
        manifest = json.loads((BASE / "identity.json").read_text())
        receipt = json.loads((BASE / "installation-verification.json").read_text())
        self.assertEqual(len(receipt), manifest["installationVerification"]["passedChecks"])
        self.assertTrue(all(value is True for value in receipt.values()))
        observation = json.loads((BASE / "adoption-observation.json").read_text())
        self.assertEqual(observation["identityManifestSha256"], identity.digest(BASE / "identity.json")["sha256"])

    def test_invalid_manifests_return_error_not_partial_success(self):
        manifest = json.loads((BASE / "identity.json").read_text())
        invalid = [None, [], {}, {"schema": "unknown"}]
        for key, value in [("source", []), ("installedUnits", {}), ("targets", {}),
                           ("installationVerification", None), ("configPath", "/private"),
                           ("publicationOwner", None)]:
            item = copy.deepcopy(manifest)
            item[key] = value
            invalid.append(item)
        item = copy.deepcopy(manifest)
        item["source"]["app.py"]["sha256"] = "not-a-digest"
        invalid.append(item)
        for item in invalid:
            with self.subTest(manifest=item), patch.object(Path, "read_text", return_value=json.dumps(item)):
                result = identity.inspect("source", None)
                self.assertEqual(result, {"ok": False, "error": "invalid-identity-manifest"})
        with patch.object(Path, "read_text", return_value="broken-json"):
            self.assertEqual(identity.inspect("source", None)["error"], "invalid-identity-manifest")

    def test_unreadable_and_changed_sources_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            for name in ["identity.json", "installation-verification.json", *json.loads((BASE / "identity.json").read_text())["source"]]:
                (temporary / name).write_bytes((BASE / name).read_bytes())
            with patch.object(identity, "BASE", temporary):
                self.assertTrue(identity.inspect("source", None)["ok"])
                (temporary / "app.py").write_text("changed app")
                result = identity.inspect("source", None)
                self.assertFalse(result["ok"])
                self.assertEqual(result["files"][str(temporary / "app.py")]["error"], "identity-mismatch")
                (temporary / "app.py").unlink()
                result = identity.inspect("source", None)
                self.assertFalse(result["ok"])
                self.assertEqual(result["files"][str(temporary / "app.py")]["error"], "unreadable")

    def test_unknown_probe_mode_and_host_are_rejected(self):
        for mode, target in [("other", None), ("installed", None), ("installed", "other")]:
            self.assertEqual(identity.inspect(mode, target), {"ok": False, "error": "invalid-probe-mode-or-target"})


if __name__ == "__main__":
    unittest.main()
