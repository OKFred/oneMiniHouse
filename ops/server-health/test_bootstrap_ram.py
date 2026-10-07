import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bootstrap_ram", Path(__file__).with_name("bootstrap-ram.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_cloud_shell_python_36_subprocess_arguments(self):
        def python36_run(args, **kwargs):
            self.assertNotIn("text", kwargs)
            self.assertNotIn("capture_output", kwargs)
            self.assertIs(kwargs["universal_newlines"], True)
            self.assertEqual(kwargs["stdout"], subprocess.PIPE)
            self.assertEqual(kwargs["stderr"], subprocess.PIPE)
            return subprocess.CompletedProcess(args, 0, '{"User":{}}', '')
        with patch.object(bootstrap.subprocess, "run", python36_run):
            self.assertEqual(bootstrap.api("GetUser", UserName="test"), {"User": {}})

    def test_prepare_never_creates_a_key_and_user_apply_does_not_print_secret(self):
        calls = []
        replies = {
            "GetUser": None, "GetPolicy": None, "CreatePolicy": {}, "CreateUser": {},
            "ListPoliciesForUser": {"Policies": {"Policy": []}},
            "ListGroupsForUser": {"Groups": {"Group": []}}, "GetLoginProfile": None,
            "ListAccessKeys": {"AccessKeys": {"AccessKey": []}}, "AttachPolicyToUser": {},
            "CreateAccessKey": {"AccessKey": {"AccessKeyId": "test-id-only", "AccessKeySecret": "never-print-this-secret"}}
        }
        def fake_api(action, **kwargs):
            calls.append(action)
            return replies[action]
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.Path, "home", return_value=Path(directory)), patch.object(bootstrap, "api", fake_api):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                bootstrap.apply(prepare_only=True)
            self.assertNotIn("CreateAccessKey", calls)
            self.assertFalse(list(Path(directory).iterdir()))
            with contextlib.redirect_stdout(output):
                bootstrap.apply()
            self.assertNotIn("never-print-this-secret", output.getvalue())
            key_file = Path(directory) / "one-minihouse-server-health-credentials.json"
            self.assertEqual(json.loads(key_file.read_text())["access_key_secret"], "never-print-this-secret")
            self.assertEqual(calls.count("CreateAccessKey"), 1)
            with contextlib.redirect_stdout(output):
                bootstrap.apply()
            self.assertEqual(calls.count("CreateAccessKey"), 1)

    def test_existing_key_without_saved_secret_stops_before_creating_another(self):
        calls = []
        def fake_api(action, **kwargs):
            calls.append(action)
            if action in ("GetUser", "GetPolicy"):
                return None
            if action == "ListAccessKeys":
                return {"AccessKeys": {"AccessKey": [{"AccessKeyId": "test-existing"}]}}
            return {}
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.Path, "home", return_value=Path(directory)), patch.object(bootstrap, "api", fake_api), patch.object(bootstrap, "verify_access", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                bootstrap.apply()
            self.assertNotIn("CreateAccessKey", calls)


if __name__ == "__main__":
    unittest.main()
