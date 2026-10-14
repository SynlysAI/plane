"""ScienceDiscovery provider projection and idempotency contract tests."""

import base64
from uuid import uuid4

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from plane.db.models import (
    Project,
    ResearchAgentBackendConnection,
    ResearchAgentSession,
    ResearchAgentRunEvent,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainUpload,
    ResearchProjectProfile,
    WorkspaceResearchSetting,
)
from plane.research.services.agent_orchestrator import AgentAssembly, issue_agent_context
from plane.research.services.backend_connections import (
    BackendConnectionError,
    resolve_science_discovery_connection,
    validate_backend_base_url,
)
from plane.research.services.chain_projection import project_science_discovery_events
from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError
from plane.tests.research_fixtures import enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


@pytest.fixture
def sd_session(db, settings):
    """Build one Agent session pinned to the ScienceDiscovery provider."""
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="SD owner")
    workspace = make_workspace(owner)
    enable_research(workspace, research_agent_enabled=True, research_chain_enabled=True)
    # 215a0f8d04 起所有 research 视图要求科研组织树有效成员。
    from plane.tests.research_fixtures import make_org_member

    make_org_member(workspace, owner)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"SD {suffix}",
        identifier=f"SD{suffix}",
        network=0,
        created_by=owner,
    )
    profile = ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        created_by=owner,
    )
    chain = ResearchChain.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        request_id=f"chain-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="GENERAL_RESEARCH",
        title="SD node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    assembly = AgentAssembly(
        persona="research-general",
        enabled_plugins=[],
        allowed_tools=["read_file", "list_files"],
        allowed_knowledge_base_ids=[],
        allowed_file_ids=[],
        unavailable_reasons=[],
        policy_id=f"plane-node:{node.id}",
    )
    grant, _token = issue_agent_context(
        workspace=workspace,
        user=owner,
        profile=profile,
        node=node,
        assembly=assembly,
        request_id=f"agent:{uuid4().hex}",
    )
    session = ResearchAgentSession.objects.create(
        workspace=workspace,
        user=owner,
        project_id=project.id,
        chain_node=node,
        context_grant=grant,
        status=ResearchAgentSession.Status.STREAMING,
        provider=ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
        sd_project_id="sd-project-1",
        sd_session_id="sd-session-1",
        sd_run_id="sd-run-1",
        assembly={},
        request_id=f"session-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    # 唯一连接来源是用户级连接（§5）：夹具直接挂一条真实加密连接。
    from plane.license.utils.encryption import encrypt_data

    session.backend_connection = ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=owner,
        base_url="http://192.168.1.10:5300",
        credential_encrypted=encrypt_data("sd-secret-token"),
        is_enabled=True,
        created_by=owner,
    )
    session.save(update_fields=["backend_connection", "updated_at"])
    return session


def test_science_discovery_projection_maps_types_payloads_and_converges_status(sd_session):
    remote_page = [
        {"sequence": 1, "event": {"type": "run.started", "runId": "sd-run-1"}},
        {"sequence": 2, "event": {"type": "assistant.delta", "delta": "文献综述"}},
        {"sequence": 3, "event": {"type": "assistant.thinking.delta", "delta": "先拆解问题"}},
        {"sequence": 4, "event": {"type": "tool.started", "trace": {"toolCallId": "t1", "name": "read_file"}}},
        {"sequence": 5, "event": {"type": "artifact.upserted", "artifact": {"name": "图1", "kind": "figure"}}},
        {"sequence": 6, "event": {"type": "run.completed", "message": {"content": "最终回答"}, "files": []}},
    ]

    projected = project_science_discovery_events(sd_session, remote_page)
    sd_session.refresh_from_db()

    assert [event.event_type for event in projected] == [
        "AI_ACTION",
        "OUTPUT",
        "AI_ACTION",
        "TOOL_CALL",
        "INTERMEDIATE_ARTIFACT",
        "OUTPUT",
    ]
    assert projected[1].payload["content"] == "文献综述"
    assert projected[2].payload["reasoning"] == "先拆解问题"
    assert projected[-1].payload["content"] == "最终回答"
    assert sd_session.status == ResearchAgentSession.Status.READY
    assert sd_session.last_error == ""
    assert ResearchChainEvent.objects.filter(source_system="SCIENCE_DISCOVERY").count() == 6


def test_science_discovery_projection_is_idempotent(sd_session):
    remote_page = [{"sequence": 1, "event": {"type": "assistant.delta", "delta": "增量"}}]

    projected = project_science_discovery_events(sd_session, remote_page)
    replayed = project_science_discovery_events(sd_session, remote_page)

    assert projected[0].pk == replayed[0].pk
    assert ResearchAgentSession.objects.get(pk=sd_session.pk).run_events.count() == 1
    assert ResearchChainEvent.objects.filter(request_id=f"chain:sd:sd-session-1:1").count() == 1


def test_science_discovery_cancelled_maps_degraded_agent_and_human_decision_chain(sd_session):
    remote_page = [{"sequence": 1, "event": {"type": "run.cancelled", "reason": "user asked"}}]

    projected = project_science_discovery_events(sd_session, remote_page)
    sd_session.refresh_from_db()
    chain_event = ResearchChainEvent.objects.get(request_id=f"chain:sd:sd-session-1:1")

    assert projected[0].event_type == "DEGRADED"
    assert chain_event.event_type == "HUMAN_DECISION"
    assert sd_session.status == ResearchAgentSession.Status.READY
    assert sd_session.last_error == "science_discovery_run_cancelled"


def test_science_discovery_failed_run_degrades_session(sd_session):
    remote_page = [{"sequence": 1, "event": {"type": "run.failed", "error": "model unavailable", "errorCode": "E1"}}]

    projected = project_science_discovery_events(sd_session, remote_page)
    sd_session.refresh_from_db()

    assert projected[0].event_type == "DEGRADED"
    assert sd_session.status == ResearchAgentSession.Status.DEGRADED
    assert sd_session.last_error == "science_discovery_run_failed"


def test_science_discovery_permission_required_waits_approval(sd_session):
    remote_page = [
        {"sequence": 1, "event": {"type": "run.started", "runId": "sd-run-1"}},
        {
            "sequence": 2,
            "event": {
                "type": "permission.required",
                "request": {"id": "perm-1", "resource": "shell", "summary": "运行分析脚本"},
            },
        },
    ]

    projected = project_science_discovery_events(sd_session, remote_page)
    sd_session.refresh_from_db()

    assert projected[-1].event_type == "APPROVAL"
    assert projected[-1].payload["requires_approval"] is True
    assert projected[-1].payload["request"]["id"] == "perm-1"
    assert sd_session.status == ResearchAgentSession.Status.WAITING_APPROVAL


def test_science_discovery_approval_bridge_translates_and_forwards(sd_session, monkeypatch):
    project_science_discovery_events(
        sd_session,
        [
            {
                "sequence": 1,
                "event": {
                    "type": "permission.required",
                    "request": {"id": "perm-1", "resource": "shell", "summary": "运行分析脚本"},
                },
            }
        ],
    )
    sd_session.refresh_from_db()
    assert sd_session.status == ResearchAgentSession.Status.WAITING_APPROVAL

    forwarded = []

    def fake_answer_approval(self, *, request_id, decision):
        forwarded.append((request_id, decision))
        return {"ok": True}

    monkeypatch.setattr(ScienceDiscoveryClient, "answer_approval", fake_answer_approval)

    client = APIClient()
    client.force_authenticate(user=sd_session.user)
    response = client.post(
        f"/api/research/workspaces/{sd_session.workspace.slug}/agent/runs/{sd_session.run_id}/approvals/",
        {
            "request_id": f"approval-{uuid4().hex}",
            "decision": "APPROVED_ALWAYS",
            "tool_call_id": "1",
            "reason": "",
        },
        format="json",
    )

    assert response.status_code == 200
    assert forwarded == [("perm-1", "allow_matching")]
    sd_session.refresh_from_db()
    assert sd_session.status == ResearchAgentSession.Status.STREAMING
    assert sd_session.run_events.filter(event_type="HUMAN_DECISION", payload__decision="APPROVED_ALWAYS").exists()


def test_science_discovery_file_upload_reconciles_hash_and_records_chain(sd_session, monkeypatch):
    import hashlib

    content = b"spec,data\n1,2\n"
    file_hash = hashlib.sha256(content).hexdigest()
    forwarded = []

    def fake_upload(self, *, session_id, file_name, content):
        forwarded.append((session_id, file_name, len(content)))
        return {
            "uploaded": [
                {
                    "status": "created",
                    "originalName": file_name,
                    "path": file_name,
                    "hash": hashlib.sha256(content).hexdigest(),
                    "size": len(content),
                }
            ],
            "errors": [],
            "files": [],
        }

    monkeypatch.setattr(ScienceDiscoveryClient, "upload_workspace_file", fake_upload)

    client = APIClient()
    client.force_authenticate(user=sd_session.user)
    upload_request_id = f"upload-{uuid4().hex}"
    response = client.post(
        f"/api/research/workspaces/{sd_session.workspace.slug}/agent/sessions/{sd_session.session_id}/files/",
        {"file": SimpleUploadedFile("spectrum.csv", content, content_type="text/csv")},
        format="multipart",
        headers={"X-Request-Id": upload_request_id},
    )

    assert response.status_code == 201
    assert forwarded == [(sd_session.sd_session_id, "spectrum.csv", len(content))]
    upload = ResearchChainUpload.objects.get(file_name="spectrum.csv")
    assert upload.status == ResearchChainUpload.Status.SUCCESS
    assert upload.file_hash == file_hash
    assert upload.external_upload_id == "spectrum.csv"
    assert upload.metadata["provider"] == "SCIENCE_DISCOVERY"
    event = ResearchAgentRunEvent.objects.get(payload__action="workspace.upload")
    assert event.event_type == "DATA_CHANGE"
    assert event.payload["sd_hash"] == file_hash
    chain_event = ResearchChainEvent.objects.get(
        request_id=f"chain:sdfile:{upload_request_id}"
    )
    assert chain_event.event_type == "DATA_CHANGE"
    assert chain_event.refs[0]["kind"] == "chain_upload"
    assert chain_event.refs[0]["id"] == str(upload.id)


def test_science_discovery_file_upload_rejects_hash_mismatch(sd_session, monkeypatch):
    def fake_upload(self, *, session_id, file_name, content):
        return {
            "uploaded": [
                {"status": "created", "originalName": file_name, "path": file_name, "hash": "deadbeef", "size": 1}
            ],
            "errors": [],
            "files": [],
        }

    monkeypatch.setattr(ScienceDiscoveryClient, "upload_workspace_file", fake_upload)

    client = APIClient()
    client.force_authenticate(user=sd_session.user)
    response = client.post(
        f"/api/research/workspaces/{sd_session.workspace.slug}/agent/sessions/{sd_session.session_id}/files/",
        {"file": SimpleUploadedFile("bad.csv", b"mismatch", content_type="text/csv")},
        format="multipart",
        headers={"X-Request-Id": f"upload-{uuid4().hex}"},
    )

    assert response.status_code == 502
    assert "hash mismatch" in response.json()["message"]
    assert not ResearchChainUpload.objects.filter(file_name="bad.csv").exists()


def test_science_discovery_artifact_content_proxies_seen_versions(sd_session, monkeypatch):
    project_science_discovery_events(
        sd_session,
        [
            {
                "sequence": 1,
                "event": {
                    "type": "artifact.upserted",
                    "artifact": {"id": "art-1", "name": "分析报告.md", "kind": "report"},
                    "version": {
                        "id": "ver-1",
                        "mediaType": "text/markdown",
                        "content": {"hash": "sha256:abc"},
                    },
                },
            }
        ],
    )
    monkeypatch.setattr(
        ScienceDiscoveryClient,
        "list_artifacts",
        lambda self, *, session_id: [{"id": "art-1", "name": "分析报告.md", "kind": "report"}],
    )

    def fake_content(self, *, session_id, version_id):
        return "# 报告正文".encode("utf-8"), "text/markdown"

    monkeypatch.setattr(ScienceDiscoveryClient, "artifact_content", fake_content)

    client = APIClient()
    client.force_authenticate(user=sd_session.user)
    listing = client.get(
        f"/api/research/workspaces/{sd_session.workspace.slug}/agent/sessions/{sd_session.session_id}/artifacts/"
    )
    content = client.get(
        f"/api/research/workspaces/{sd_session.workspace.slug}/agent/sessions/{sd_session.session_id}"
        f"/artifact-versions/ver-1/content/"
    )
    unseen = client.get(
        f"/api/research/workspaces/{sd_session.workspace.slug}/agent/sessions/{sd_session.session_id}"
        f"/artifact-versions/other-ver/content/"
    )

    assert listing.status_code == 200
    assert listing.json()["count"] == 1
    assert content.status_code == 200
    assert content.content == "# 报告正文".encode("utf-8")
    assert content["Content-Type"] == "text/markdown"
    encoded_name = content["Content-Disposition"].split("?b?")[1].split("?=")[0]
    assert "分析报告.md" in base64.b64decode(encoded_name).decode("utf-8")
    assert unseen.status_code == 404


def test_backend_base_url_ssrf_validation_rejects_unsafe_targets(settings):
    """用户自填 URL 必须过 SSRF 防线：仅 http/https、拒回环/metadata/白名单外（§5）。"""
    settings.SCIENCE_DISCOVERY_ALLOWED_CIDRS = ["192.168.0.0/16", "10.0.0.0/8"]
    settings.SCIENCE_DISCOVERY_ALLOW_LOOPBACK = False

    with pytest.raises(BackendConnectionError, match="http/https"):
        validate_backend_base_url("ftp://192.168.1.10:5300")
    with pytest.raises(BackendConnectionError, match="Loopback"):
        validate_backend_base_url("http://127.0.0.1:5300")
    with pytest.raises(BackendConnectionError, match="not allowed"):
        validate_backend_base_url("http://169.254.169.254:5300")
    with pytest.raises(BackendConnectionError, match="outside"):
        validate_backend_base_url("http://8.8.8.8:5300")
    validate_backend_base_url("http://192.168.1.10:5300")
    validate_backend_base_url("http://10.26.15.93:5300")


def test_backend_connection_crud_stores_token_encrypted(sd_session, settings):
    """连接令牌密文落库，接口只回显已配置（§5 令牌安全）。"""
    workspace = sd_session.workspace
    owner = sd_session.user
    settings.SCIENCE_DISCOVERY_ALLOWED_CIDRS = ["192.168.0.0/16"]
    client = APIClient()
    client.force_authenticate(user=owner)

    created = client.post(
        f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/",
        {"base_url": "http://192.168.1.10:5300", "token": "sd-secret-token", "is_enabled": True},
        format="json",
    )
    assert created.status_code == 201, created.content.decode()
    connection = ResearchAgentBackendConnection.objects.get(workspace=workspace, user=owner)
    assert connection.credential_encrypted != "sd-secret-token"
    assert "sd-secret-token" not in connection.credential_encrypted

    listed = client.get(f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/")
    assert listed.status_code == 200
    assert listed.json()["connection"]["has_credential"] is True
    assert "sd-secret-token" not in str(listed.json())

    # 会话以 PROTECT 引用连接：删除连接前先解除本测试工作区的引用。
    ResearchAgentSession.objects.filter(workspace=workspace).update(backend_connection=None)
    removed = client.delete(f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/")
    assert removed.status_code == 204
    assert not ResearchAgentBackendConnection.objects.filter(workspace=workspace, user=owner).exists()


def test_backend_connection_test_updates_health(sd_session, monkeypatch):
    """测试连接走 GET /api/models，成功更新健康状态（§5）。"""
    workspace = sd_session.workspace
    owner = sd_session.user
    connection = sd_session.backend_connection
    monkeypatch.setattr(ScienceDiscoveryClient, "list_models", lambda self: [{"id": "m1"}, {"id": "m2"}])
    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.post(f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/test/")
    connection.refresh_from_db()

    assert response.status_code == 200
    assert response.json() == {"ok": True, "models": 2}
    assert connection.health_status == ResearchAgentBackendConnection.HealthStatus.OK


def test_provider_resolution_honours_governance_and_enablement(sd_session):
    """路由只看治理开关与学生意图，不探测在线状态（§5）。"""
    workspace = sd_session.workspace
    owner = sd_session.user
    setting, _ = WorkspaceResearchSetting.objects.get_or_create(workspace=workspace)
    connection = sd_session.backend_connection
    connection.is_enabled = True
    connection.save(update_fields=["is_enabled", "updated_at"])

    setting.research_agent_user_backend_enabled = False
    setting.save()
    assert resolve_science_discovery_connection(workspace, owner) is None

    setting.research_agent_user_backend_enabled = True
    setting.save()
    resolved = resolve_science_discovery_connection(workspace, owner)
    assert resolved is not None and resolved.pk == connection.pk

    connection.is_enabled = False
    connection.save()
    assert resolve_science_discovery_connection(workspace, owner) is None


def test_specialist_sync_creates_then_skips_and_updates_on_drift(monkeypatch):
    """目录下发幂等：首次创建、内容一致跳过、漂移时更新（§10）。"""
    from plane.research.services.specialist_catalog import SPECIALIST_CATALOG, sync_specialists

    remote = [{"id": "built-in-1", "name": "内置专家", "builtIn": True}]
    created, updated = [], []

    def fake_list(self):
        return remote

    def fake_create(self, *, name, description, instructions):
        created.append(name)
        item = {"id": f"new-{len(created)}", "name": name, "description": description, "instructions": instructions}
        remote.append(item)
        return item

    def fake_update(self, *, specialist_id, name, description, instructions):
        updated.append((specialist_id, name))
        for item in remote:
            if item["id"] == specialist_id:
                item["description"] = description
                item["instructions"] = instructions
        return {"id": specialist_id}

    monkeypatch.setattr(ScienceDiscoveryClient, "list_specialists", fake_list)
    monkeypatch.setattr(ScienceDiscoveryClient, "create_specialist", fake_create)
    monkeypatch.setattr(ScienceDiscoveryClient, "update_specialist", fake_update)

    first = sync_specialists(ScienceDiscoveryClient())
    assert sorted(first) == sorted(entry["name"] for entry in SPECIALIST_CATALOG)
    assert len(created) == len(SPECIALIST_CATALOG)

    # 二次同步：内容一致，不创建不更新。
    second = sync_specialists(ScienceDiscoveryClient())
    assert second == first
    assert len(created) == len(SPECIALIST_CATALOG)
    assert updated == []

    # 内容漂移：同名 specialist 被就地更新，不重复创建。
    for item in remote:
        if not item.get("builtIn") and item["name"] == SPECIALIST_CATALOG[0]["name"]:
            item["instructions"] = "过期的方法论"
    sync_specialists(ScienceDiscoveryClient())
    assert len(created) == len(SPECIALIST_CATALOG)
    assert len(updated) == 1


def test_specialist_id_for_node_maps_and_fails_open(monkeypatch):
    """节点类型映射到对应 specialist；下发失败返回 None 不阻断会话（§10）。"""
    from plane.research.services.specialist_catalog import specialist_id_for_node

    def fake_sync(client):
        return {"学术研究助手": "sp-ars", "科技文献检索专家": "sp-sci", "谱图解析专家": "sp-spec", "高分子性能预测专家": "sp-poly"}

    monkeypatch.setattr("plane.research.services.specialist_catalog.sync_specialists", fake_sync)
    assert specialist_id_for_node(None, "LITERATURE_REVIEW") == "sp-sci"
    assert specialist_id_for_node(None, "EXPERIMENT") == "sp-spec"
    assert specialist_id_for_node(None, "ANALYSIS") == "sp-poly"
    assert specialist_id_for_node(None, "GENERAL_RESEARCH") == "sp-ars"
    assert specialist_id_for_node(None, "UNKNOWN_TYPE") == "sp-ars"

    def failing_sync(client):
        raise ScienceDiscoveryError("science_discovery_not_configured", "down")

    monkeypatch.setattr("plane.research.services.specialist_catalog.sync_specialists", failing_sync)
    assert specialist_id_for_node(None, "LITERATURE_REVIEW") is None
