"""显式启用的隔离数据库并发测试，输出冷聚合和缓存命中的 P95。"""

import json
import logging
import math
import os
from concurrent.futures import ThreadPoolExecutor
from statistics import median
from threading import Lock
from time import perf_counter
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.cache import cache
from django.db import close_old_connections
from rest_framework.test import APIClient

from plane.db.models import ResearchChainNodeTask, ResearchStageInstance, StageReviewerAssignment
from plane.tests.contract.app.test_research_todos import (
    _additional_report,
)

pytestmark = [
    pytest.mark.slow,
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(os.getenv("PLANE_TODO_LOAD_TEST") != "1", reason="显式启用待办并发测试"),
]


class RequestMeasurements(logging.Handler):
    """收集当前进程内待办请求的结构化观测。"""

    def __init__(self):
        """初始化观测列表及并发写保护。"""
        super().__init__()
        self.records = []
        self.record_lock = Lock()

    def emit(self, record):
        """仅保留请求观测，不保留任何业务内容。"""
        if getattr(record, "event", None) == "workspace_todo_request":
            with self.record_lock:
                self.records.append(record)


def _percentile(values, percentile):
    """返回最近秩百分位数。"""
    return sorted(values)[max(0, math.ceil(len(values) * percentile) - 1)]


def _exercise(url, user, requests, concurrency):
    """使用独立客户端和数据库连接并发执行真实 API 请求。"""

    def call(_index):
        """测量一个请求并及时释放线程的数据库连接。"""
        close_old_connections()
        client = APIClient()
        client.force_authenticate(user=user)
        started = perf_counter()
        try:
            response = client.get(url)
            assert response.status_code == 200, response.data
            assert response.data["degraded_sources"] == [], response.data
            return (perf_counter() - started) * 1000, response.data["total_count"]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        results = list(executor.map(call, range(requests)))
    assert len({count for _, count in results}) == 1
    return [duration for duration, _ in results], results[0][1]


def test_workspace_todos_concurrent_cold_and_cached(load_env, monkeypatch):
    """在数百条待办与多个阶段下比较完全冷聚合及五秒缓存。"""
    env = load_env
    report_count = int(os.getenv("PLANE_TODO_LOAD_REPORTS", "100"))
    task_count = int(os.getenv("PLANE_TODO_LOAD_TASKS", "300"))
    requests = int(os.getenv("PLANE_TODO_LOAD_REQUESTS", "60"))
    concurrency = int(os.getenv("PLANE_TODO_LOAD_CONCURRENCY", "6"))
    assert min(report_count, task_count, requests, concurrency) > 0
    for index in range(1, report_count + 1):
        _additional_report(env, index)
    ResearchChainNodeTask.objects.bulk_create(
        [
            ResearchChainNodeTask(
                workspace=env["workspace"],
                chain=env["chain"],
                node=env["paper_node"],
                title=f"负载任务 {index}",
                status="ASSIGNED",
                assignee=env["advisor"],
                assigned_by=env["student"],
                request_id=f"load-task-{uuid4()}",
                payload_hash="a" * 64,
            )
            for index in range(task_count)
        ]
    )
    stages = [
        ResearchStageInstance.objects.create(
            workspace=env["workspace"],
            project=env["project"],
            stage=stage_type,
            sort_order=index,
            status="SUBMITTED",
            org_unit=env["group_a1"],
        )
        for index, stage_type in enumerate(("OPENING", "MIDTERM", "FINAL"), start=1)
    ]
    StageReviewerAssignment.objects.bulk_create(
        [
            StageReviewerAssignment(stage_instance=stage, reviewer=env["advisor"], reviewer_role="DIRECT_ADVISOR")
            for stage in stages
        ]
    )
    # 仅关闭查询日志的 DEBUG 存储，保留 execute_wrapper 计数。
    from django.conf import settings

    monkeypatch.setattr(settings, "DEBUG", False)
    logger = logging.getLogger("plane.api")
    measurements = RequestMeasurements()
    previous_level = logger.level
    logger.setLevel(logging.INFO)
    logger.addHandler(measurements)
    url = f"/api/workspaces/{env['workspace'].slug}/todos/?limit=50"
    try:
        # 不读写响应缓存，确保所有并发请求执行冷聚合。
        with patch("plane.app.views.workspace.todos.workspace_todo_cache_version", return_value=None):
            cold, total_count = _exercise(url, env["advisor"], requests, concurrency)
        cold_records = measurements.records[:]
        measurements.records.clear()
        cache.clear()
        _exercise(url, env["advisor"], 1, 1)
        measurements.records.clear()
        cached, _ = _exercise(url, env["advisor"], requests, concurrency)
        cached_records = measurements.records[:]
    finally:
        logger.removeHandler(measurements)
        logger.setLevel(previous_level)
    assert len(cold_records) == len(cached_records) == requests
    assert not any(record.cache_hit for record in cold_records)
    assert any(record.cache_hit for record in cached_records)
    result = {
        "reports_added": report_count,
        "tasks_added": task_count,
        "total_todos": total_count,
        "requests_per_mode": requests,
        "concurrency": concurrency,
        "cold": {
            "p50_ms": round(median(cold), 2),
            "p95_ms": round(_percentile(cold, 0.95), 2),
            "sql_p50": median(record.query_count for record in cold_records),
        },
        "cached": {
            "p50_ms": round(median(cached), 2),
            "p95_ms": round(_percentile(cached, 0.95), 2),
            "sql_p50": median(record.query_count for record in cached_records),
            "hit_ratio": sum(record.cache_hit for record in cached_records) / requests,
        },
    }
    print("workspace_todos_load=" + json.dumps(result, ensure_ascii=False))
    budget = os.getenv("PLANE_TODO_LOAD_P95_MS")
    if budget:
        assert result["cold"]["p95_ms"] <= float(budget)
        assert result["cached"]["p95_ms"] <= float(budget)
