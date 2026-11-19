"""Protects the deployment contracts (private env file creation, checksum verification, Compose file validity); no Docker daemon, real database, or model calls."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from dotenv import dotenv_values

from src.deployment.config import GGUF_FILENAME, configure_stack, obtain_mongodb_uri, validate_mongodb_uri

ROOT = Path(__file__).resolve().parents[1]
FAKE_URI = "mongodb+srv://test_user:test_pass@cluster.example.invalid/"


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.model = self.directory / GGUF_FILENAME
        self.model.write_bytes(b"synthetic test artifact, not a model")
        self.sha = hashlib.sha256(self.model.read_bytes()).hexdigest()
        self.output = self.directory / "private.env"

    def test_configuration_is_private_and_existing_secrets_are_preserved(self):
        configure_stack(self.directory, self.sha, self.output, FAKE_URI)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        values = dotenv_values(self.output)
        self.assertEqual(values["MODEL_GGUF_DIR"], str(self.directory))
        self.assertEqual(values["MODEL_GGUF_SHA256"], self.sha)
        self.assertEqual(values["MONGODB_URI"], FAKE_URI)
        self.assertEqual(values["SESSION_COOKIE_NAME"], "ownhelp_session")
        self.assertNotIn("MONGO_ROOT_PASSWORD", values)
        secrets = [values[key] for key in ("CHAT_BACKEND_TOKEN", "CHAT_FOLLOW_UP_SECRET")]
        self.assertEqual(len(set(secrets)), 2)
        self.assertTrue(all(len(value) == 64 for value in secrets))
        before = self.output.read_bytes()
        with self.assertRaises(FileExistsError):
            configure_stack(self.directory, self.sha, self.output, FAKE_URI)
        self.assertEqual(self.output.read_bytes(), before)

    def test_wrong_or_invalid_checksum_writes_nothing(self):
        for checksum in ("0" * 64, "not a checksum"):
            with self.subTest(checksum=checksum), self.assertRaises(ValueError):
                configure_stack(self.directory, checksum, self.output, FAKE_URI)
            self.assertFalse(self.output.exists())

    def test_invalid_atlas_uri_writes_nothing_and_is_not_echoed(self):
        for uri in ("", "http://example.invalid", "mongodb+srv://u:<password>@c/", "mongodb://u:p w@h/", "mongodb://u:p$x@h/"):
            with self.subTest(uri=uri), self.assertRaises(ValueError) as caught:
                configure_stack(self.directory, self.sha, self.output, uri)
            self.assertNotIn("p w", str(caught.exception))
            self.assertFalse(self.output.exists())
        self.assertEqual(validate_mongodb_uri("  mongodb://localhost:27017/  "), "mongodb://localhost:27017/")

    def test_uri_comes_from_environment_or_hidden_prompt_only(self):
        def no_prompt(_):
            raise AssertionError("prompt must not be used when MONGODB_URI is set")

        self.assertEqual(obtain_mongodb_uri({"MONGODB_URI": FAKE_URI}, no_prompt), FAKE_URI)
        asked = []
        self.assertEqual(obtain_mongodb_uri({}, lambda text: asked.append(text) or FAKE_URI), FAKE_URI)
        self.assertEqual(len(asked), 1)
        with self.assertRaises(ValueError):
            obtain_mongodb_uri({}, lambda text: "not-a-uri")

    def test_setup_script_has_no_uri_argument(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/setup_stack.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("MONGODB_URI", result.stdout)
        for flag in ("--mongodb-uri", "--uri", "--atlas-uri"):
            self.assertNotIn(flag, result.stdout)

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI unavailable")
    def test_compose_requires_the_atlas_uri(self):
        env = {key: value for key, value in os.environ.items() if key != "MONGODB_URI"}
        configure_stack(self.directory, self.sha, self.output, FAKE_URI)
        lines = [line for line in self.output.read_text().splitlines() if not line.startswith("MONGODB_URI=")]
        broken = self.directory / "broken.env"
        broken.write_text("\n".join(lines) + "\n")
        command = ["docker", "compose", "--env-file", str(broken), "-f", str(ROOT / "compose.yaml"), "config", "-q"]
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MONGODB_URI", result.stderr)

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI unavailable")
    def test_compose_contract_is_isolated_and_has_no_seeding_or_public_backends(self):
        configure_stack(self.directory, self.sha, self.output, FAKE_URI)
        env = {key: value for key, value in os.environ.items() if key not in dotenv_values(self.output)}
        command = ["docker", "compose", "--env-file", str(self.output), "-f", str(ROOT / "compose.yaml"), "config", "--format", "json"]
        result = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
        config = json.loads(result.stdout)
        services = config["services"]
        self.assertEqual(set(services), {"ollama", "model-init", "chat-service", "gateway", "dashboard"})
        self.assertEqual(config["name"], "ownhelp")
        self.assertEqual(set(config["volumes"]), {"ollama_models", "hf_cache"})
        devices = services["ollama"]["deploy"]["resources"]["reservations"]["devices"]
        self.assertEqual(devices[0]["driver"], "nvidia")
        self.assertEqual(devices[0]["count"], -1)
        self.assertIn("gpu", devices[0]["capabilities"])
        for name in ("ollama", "model-init", "chat-service"):
            self.assertFalse(services[name].get("ports"))
        for name in ("gateway", "dashboard"):
            self.assertTrue(all(port["host_ip"] == "127.0.0.1" for port in services[name]["ports"]))
        gateway, chat = services["gateway"]["environment"], services["chat-service"]["environment"]
        self.assertEqual(gateway["APP_MODE"], "standard")
        for key in ("MONGODB_URI", "MONGODB_DB_NAME", "EMBEDDING_MODEL_NAME", "OLLAMA_MODEL", "CHAT_BACKEND_TOKEN"):
            self.assertEqual(gateway[key], chat[key])
        self.assertEqual(gateway["CHAT_BACKEND_URL"], "http://chat-service:8100")
        self.assertEqual(services["chat-service"]["depends_on"]["model-init"]["condition"], "service_completed_successfully")
        self.assertNotIn("gateway", services["chat-service"]["depends_on"])
        model_mount = next(mount for mount in services["model-init"]["volumes"] if mount["target"] == "/model-import/" + GGUF_FILENAME)
        self.assertTrue(model_mount["read_only"])
        self.assertFalse(model_mount["bind"]["create_host_path"])
        # The database is the client's Atlas cluster: the URI is passed through unchanged and no
        # service waits on a (nonexistent) local database.
        self.assertEqual(gateway["MONGODB_URI"], FAKE_URI)
        self.assertEqual(gateway["SESSION_COOKIE_NAME"], "ownhelp_session")
        self.assertEqual(gateway["UPLOAD_STAGING_DIR"], "/tmp/ownhelp_uploads")
        for name in ("chat-service", "gateway"):
            self.assertNotIn("mongodb", services[name]["depends_on"])
        self.assertEqual(services["gateway"]["image"], "ownhelp-runtime:local")
        self.assertFalse((ROOT / "compose.atlas.yaml").exists())


class StandardImageContractTests(unittest.TestCase):
    """Static checks of the standard-image inputs; they do not build images."""

    def test_gateway_image_installs_only_hashed_cpu_dependencies(self):
        dockerfile = (ROOT / "gateway/Dockerfile.standard").read_text()
        self.assertIn("--require-hashes", dockerfile)
        self.assertIn("requirements.cpu.lock", dockerfile)
        lock = (ROOT / "deployment/requirements.cpu.lock").read_text()
        self.assertIn("torch==2.14.1+cpu", lock)
        for name in ("nvidia-", "triton", "cuda-"):
            self.assertNotIn("\n" + name, lock)
        packages = [line for line in lock.splitlines() if "==" in line and not line.startswith((" ", "#"))]
        self.assertTrue(packages)
        self.assertEqual(lock.count("--hash=sha256:") > len(packages), True)

    def test_gateway_image_carries_only_the_preset_manifest_not_tenant_data(self):
        dockerfile = (ROOT / "gateway/Dockerfile.standard").read_text()
        self.assertIn("COPY data/fixtures/demo_manifest.json", dockerfile)
        self.assertNotRegex(dockerfile, r"COPY data(/|\s)(?!fixtures/demo_manifest\.json)")
        self.assertTrue((ROOT / "data/fixtures/demo_manifest.json").is_file())

    def test_dashboard_fonts_do_not_require_network_at_build_time(self):
        layout = (ROOT / "dashboard/src/app/layout.js").read_text()
        self.assertNotIn("next/font/google", layout)
        package = json.loads((ROOT / "dashboard/package.json").read_text())
        self.assertIn("geist", package["dependencies"])


class ModelImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.model = self.directory / GGUF_FILENAME
        self.model.write_bytes(b"synthetic artifact")
        self.recipe = self.directory / "Modelfile"
        self.recipe.write_text("FROM ./" + GGUF_FILENAME + "\n")
        self.installed = self.directory / "installed.txt"
        self.creates = self.directory / "creates.txt"
        fake = self.directory / "ollama"
        fake.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
installed = pathlib.Path(os.environ['TEST_INSTALLED'])
if sys.argv[1] == 'show':
    if not installed.exists(): sys.exit(1)
    print(installed.read_text())
elif sys.argv[1] == 'create':
    if os.getenv('TEST_CREATE_FAIL'): sys.exit(17)
    with open(os.environ['TEST_CREATES'], 'a') as handle: handle.write('x')
    installed.write_text(pathlib.Path(sys.argv[-1]).read_text())
else: sys.exit(2)
''')
        fake.chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
                    "OLLAMA_MODEL": "test-model", "MODEL_IMPORT_DIR": str(self.directory),
                    "MODEL_IMPORT_STATE_DIR": str(self.directory / "state"),
                    "MODEL_GGUF_SHA256": hashlib.sha256(self.model.read_bytes()).hexdigest(),
                    "TEST_INSTALLED": str(self.installed), "TEST_CREATES": str(self.creates)}

    def run_import(self):
        return subprocess.run(["sh", str(ROOT / "scripts/import_model.sh")], env=self.env, capture_output=True, text=True)

    def test_import_is_idempotent_but_changed_recipe_or_installed_identity_is_repaired(self):
        self.assertEqual(self.run_import().returncode, 0)
        self.assertEqual(self.run_import().returncode, 0)
        self.assertEqual(self.creates.read_text(), "x")
        self.installed.write_text("unexpected different model")
        self.assertEqual(self.run_import().returncode, 0)
        self.assertEqual(self.creates.read_text(), "xx")
        self.recipe.write_text(self.recipe.read_text() + "PARAMETER num_ctx 4096\n")
        self.assertEqual(self.run_import().returncode, 0)
        self.assertEqual(self.creates.read_text(), "xxx")

    def test_corrupt_artifact_is_never_imported(self):
        self.model.write_bytes(b"changed")
        self.assertNotEqual(self.run_import().returncode, 0)
        self.assertFalse(self.creates.exists())

    def test_failed_import_never_records_success(self):
        self.env["TEST_CREATE_FAIL"] = "1"
        self.assertNotEqual(self.run_import().returncode, 0)
        self.assertEqual(list((self.directory / "state").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
