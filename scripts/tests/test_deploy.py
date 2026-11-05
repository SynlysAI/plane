"""使用隔离命令替身验证迁移、后端重建及发布验收行为。"""

import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

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
        print("test-" + args[-1])
elif args[0] == "inspect":
    if "ExitCode" in args[2]:
        print("0" if mode == "success" else "1")
    elif "State.Status" in args[2]:
        is_migrator = args[-1] == "test-migrator"
        failed_service = "test-" + os.environ.get("DEPLOY_TEST_FAILED_SERVICE", "")
        print("exited" if (is_migrator and mode != "timeout") or args[-1] == failed_service else "running")
    else:
        print("running" if mode == "timeout" else "exited")
elif args[0] == "logs":
    if os.environ.get("DEPLOY_TEST_LOG_FAILURE"):
        print("logs unavailable", file=sys.stderr)
        sys.exit(7)
    print("AttributeError: historical model has no all_objects", file=sys.stderr)
"""


CURL_STUB = """#!/usr/bin/env python3
import os
import sys

args = sys.argv[1:]
url = next((value for value in args if value.startswith("http://")), "")
output_format = ""
if "-w" in args:
    output_format = args[args.index("-w") + 1]
if "/api/email-actions/" in url:
    code, content_type = "401", "application/json; charset=utf-8"
elif "Logo.png" in url:
    code, content_type = "200", "image/png"
else:
    code, content_type = "200", "text/html; charset=utf-8"
if os.environ.get("DEPLOY_TEST_HTTP_PATH", "no-match") in url:
    code = os.environ.get("DEPLOY_TEST_HTTP_CODE", code)
    content_type = os.environ.get("DEPLOY_TEST_CONTENT_TYPE", content_type)
print(output_format.replace("%{http_code}", code).replace("%{content_type}", content_type))
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
            "curl": CURL_STUB,
            "sleep": "#!/bin/sh\nexit 0\n",
        }.items():
            path = self.bin / name
            path.write_text(textwrap.dedent(content), encoding="utf-8")
            path.chmod(0o755)

    def _deploy(self, mode, log_failure=False, overrides=None):
        """执行指定迁移结果的部署模拟。

        Args:
            mode: success、failure 或 timeout。
            log_failure: 是否模拟 Docker 日志读取失败。
            overrides: 覆盖命令替身行为的环境变量。

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
        environment.update(overrides or {})
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
        recreate_call = next((call for call in calls if "--force-recreate" in call), [])
        self.assertTrue(
            {
                "api",
                "worker",
                "beat-worker",
                "document-converter",
                "notification-generation-worker",
                "notification-email-worker",
            }.issubset(set(recreate_call))
        )
        self.assertIn("all checks passed", result.stdout)
        self.assertFalse(any(call[0] == "logs" for call in calls))

    def test_stopped_notification_worker_fails_verification(self):
        """任一通知专用 Worker 未运行时必须报告部署失败。"""
        for service in ("notification-generation-worker", "notification-email-worker"):
            with self.subTest(service=service):
                result, _ = self._deploy("success", overrides={"DEPLOY_TEST_FAILED_SERVICE": service})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"ERR {service}", result.stdout)

    def test_email_routes_reject_wrong_status_or_content_type(self):
        """确认页、转派 API 和 Logo 必须满足状态与内容类型契约。"""
        cases = (
            ("/email-actions/", "Assignment transfer page", "404", "text/html"),
            ("/email-actions/", "Assignment transfer page", "200", "application/json"),
            ("/api/email-actions/", "Assignment transfer API", "404", "application/json"),
            ("/api/email-actions/", "Assignment transfer API", "401", "text/html"),
            ("/static/logos/", "Email logo", "200", "text/html"),
            ("/static/logos/", "Email logo", "404", "image/png"),
        )
        for path, name, code, content_type in cases:
            with self.subTest(name=name, code=code, content_type=content_type):
                result, _ = self._deploy(
                    "success",
                    overrides={
                        "DEPLOY_TEST_HTTP_PATH": path,
                        "DEPLOY_TEST_HTTP_CODE": code,
                        "DEPLOY_TEST_CONTENT_TYPE": content_type,
                    },
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"ERR {name}", result.stdout)


if __name__ == "__main__":
    unittest.main()
