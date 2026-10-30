"""使用隔离命令替身验证部署迁移失败时的诊断与中止行为。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


PROJECT_DIR = Path(__file__).resolve().parents[2]
DOCKER_STUB = """#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["DEPLOY_TEST_CALLS"], "a") as stream:
    stream.write(json.dumps(args) + "\\n")
mode = os.environ["DEPLOY_TEST_MODE"]
if args[0] == "compose":
    if "ps" in args:
        print("test-migrator")
elif args[0] == "inspect":
    if "ExitCode" in args[2]:
        print("0" if mode == "success" else "1")
    else:
        print("running" if mode == "timeout" else "exited")
elif args[0] == "logs":
    if os.environ.get("DEPLOY_TEST_LOG_FAILURE"):
        print("logs unavailable", file=sys.stderr)
        sys.exit(7)
    print("AttributeError: historical model has no all_objects", file=sys.stderr)
"""


class DeployMigrationTests(unittest.TestCase):
    """在临时项目内执行部署脚本，不访问 Docker 或远程服务。"""

    def setUp(self):
        """准备最小项目及命令替身。"""
        temporary = tempfile.TemporaryDirectory(prefix="plane-deploy-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(PROJECT_DIR / "scripts/deploy.sh", self.root / "scripts/deploy.sh")
        for name in ("web", "api", "space", "admin", "live"):
            directory = self.root / "apps" / name
            directory.mkdir(parents=True)
            (directory / ".env").touch()
        for name in (".env", "docker-compose-local.yml", "docker-compose-prod-web.yml"):
            (self.root / name).touch()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, content in {
            "docker": DOCKER_STUB,
            "git": "#!/bin/sh\nexit 0\n",
            "pnpm": "#!/bin/sh\nexit 0\n",
            "curl": "#!/bin/sh\nprintf '200'\n",
        }.items():
            path = self.bin / name
            path.write_text(textwrap.dedent(content), encoding="utf-8")
            path.chmod(0o755)

    def _deploy(self, mode, log_failure=False):
        """执行指定迁移结果的部署模拟。

        Args:
            mode: success、failure 或 timeout。
            log_failure: 是否模拟 Docker 日志读取失败。

        Returns:
            子进程执行结果及 Docker 调用参数列表。
        """
        calls = self.root / "calls.jsonl"
        environment = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "DEPLOY_TEST_CALLS": str(calls),
            "DEPLOY_TEST_MODE": mode,
            "PLANE_MIGRATION_TIMEOUT_SECONDS": "0.2" if mode == "timeout" else "5",
        }
        if log_failure:
            environment["DEPLOY_TEST_LOG_FAILURE"] = "1"
        result = subprocess.run(
            ["bash", str(self.root / "scripts/deploy.sh"), "--backend", "--skip-pull"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return result, [json.loads(line) for line in calls.read_text(encoding="utf-8").splitlines()]

    def _assert_backend_not_recreated(self, calls):
        """确认迁移失败后没有重建后端。

        Args:
            calls: Docker 调用参数列表。
        """
        self.assertFalse(any("--force-recreate" in call for call in calls))

    def test_migration_failure_prints_logs_and_stops(self):
        """迁移异常应直接显示日志并中止部署。"""
        result, calls = self._deploy("failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("historical model has no all_objects", result.stderr)
        self.assertIn("migration exited with code 1", result.stderr)
        self.assertIn(["logs", "--tail", "100", "test-migrator"], calls)
        self._assert_backend_not_recreated(calls)

    def test_migration_timeout_prints_logs_and_stops(self):
        """迁移超时也应显示当前日志并中止部署。"""
        result, calls = self._deploy("timeout")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migration timed out after 0.2 seconds", result.stderr)
        self.assertIn("historical model has no all_objects", result.stderr)
        self._assert_backend_not_recreated(calls)

    def test_log_failure_preserves_migration_error(self):
        """日志不可用时仍须保留迁移的失败原因。"""
        result, calls = self._deploy("failure", log_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("logs unavailable", result.stderr)
        self.assertIn("migration exited with code 1", result.stderr)
        self._assert_backend_not_recreated(calls)

    def test_success_continues_to_backend_and_health_checks(self):
        """迁移成功后应继续重建后端并通过健康检查。"""
        result, calls = self._deploy("success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any("--force-recreate" in call and "api" in call for call in calls))
        self.assertIn("all checks passed", result.stdout)
        self.assertFalse(any(call[0] == "logs" for call in calls))


if __name__ == "__main__":
    unittest.main()
