"""Stage-three topic evaluations backed by the existing Agent runtimes."""

import json
import re
import uuid

from django.db import transaction
from django.utils import timezone
from rest_framework import status

from plane.db.models import (
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchChainStageEvaluation,
)
from plane.license.utils.encryption import decrypt_data
from plane.research.services.agent_orchestrator import create_science_discovery_session
from plane.research.services.agent_runtime import (
    SynloraRuntimeError,
    resolve_synlora_runtime,
    synlora_research_context,
)
from plane.research.services.backend_connections import resolve_science_discovery_connection
from plane.research.services.chain_projection import project_science_discovery_events
from plane.research.services.chain_stage_approvals import (
    ChainStageRuleError,
    EDITABLE_STAGE_STATUSES,
    create_stage_precheck,
    material_state,
    missing_material_requirements,
    stage_material_version,
)
from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.errors import ResearchErrorCode

EVALUATION_PROMPT_VERSION = "topic-evaluation-deepseek.v1"
EVALUATION_TIMEOUT_MINUTES = 10
CRITERIA_CODES = ("intelligence", "moat", "uniqueness", "positioning", "irreplaceability")
CRITERIA_TITLES = {
    "intelligence": "智能化",
    "moat": "护城河",
    "uniqueness": "独特性",
    "positioning": "分级分类（顶天 / 立地）",
    "irreplaceability": "非我莫属",
}


def _http_error(error_code, message, http_status=status.HTTP_409_CONFLICT, **extra):
    return ChainStageRuleError(error_code, message, http_status, **extra)


def evaluation_material_snapshot(stage):
    """Project the exact material evidence submitted to one evaluation.

    Args:
        stage: The stage-three approval record.

    Returns:
        A bounded JSON-serializable materials dictionary.
    """
    requirements = []
    for requirement in material_state(stage):
        requirements.append(
            {
                "code": requirement["code"],
                "title": requirement["title"],
                "complete": requirement["complete"],
                "items": [
                    {
                        "title": item["title"],
                        "description": item["description"][:20_000],
                        "upload": (
                            {
                                "id": item["upload_detail"]["id"],
                                "file_name": item["upload_detail"]["file_name"],
                                "status": item["upload_detail"]["status"],
                            }
                            if item.get("upload_detail")
                            else None
                        ),
                    }
                    for item in requirement["items"]
                ],
            }
        )
    return {"requirements": requirements}


def build_evaluation_prompt(track, snapshot):
    """Build the strict DeepSeek evaluation prompt for stage three.

    Args:
        track: ``BASIC`` or ``APPLIED`` research track.
        snapshot: The material snapshot submitted for evaluation.

    Returns:
        The prompt text requesting one JSON object.
    """
    criteria = "\n".join(f"- {code}: {title}" for code, title in CRITERIA_TITLES.items())
    probability_rule = (
        "对基础研究必须给出 subjournal_probability 与 conservative_probability（0-100，AI 偏乐观，保守值需降一档）。"
        if track == "BASIC"
        else "对产业化研究 subjournal_probability 与 conservative_probability 可为 null，不得用论文档次阻断。"
    )
    return (
        "你是实验室阶段 3 选题评估专家。请仅基于下列材料判断，不要编造证据。\n"
        f"研究轨道：{'基础研究（顶天）' if track == 'BASIC' else '应用基础 / 技术创新（立地）'}\n"
        f"五点判据：\n{criteria}\n"
        f"{probability_rule}\n"
        "请评估预期论文档次，并为五点判据逐项给出 0-10 分、证据和主要不足。\n"
        "只输出一个 JSON 对象，不要 Markdown，不要额外说明。Schema：\n"
        '{"subjournal_probability": number|null,"conservative_probability": number|null,'
        '"paper_tier": string,"criteria":[{"code": string,"title": string,"score": number,'
        '"evidence": string,"gap": string}],"risks": string[],"recommendations": string[]}\n'
        f"材料快照：\n{json.dumps(snapshot, ensure_ascii=False)}"
    )


def _extract_json_object(content):
    text = str(content or "").strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        return json.loads(fenced.group(1))
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object found")
    return json.loads(text[start : end + 1])


def _number_or_none(value):
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("probability is not numeric") from exc
    if not 0 <= number <= 100:
        raise ValueError("probability is outside 0-100")
    return round(number, 2)


def parse_evaluation_output(content, track):
    """Validate and normalize the model's JSON answer.

    Args:
        content: The final assistant output from an Agent run.
        track: ``BASIC`` or ``APPLIED`` research track.

    Returns:
        A normalized result dictionary with an explicit decision.
    """
    payload = _extract_json_object(content)
    if not isinstance(payload, dict):
        raise ValueError("evaluation output is not an object")

    optimistic = _number_or_none(payload.get("subjournal_probability"))
    conservative = _number_or_none(payload.get("conservative_probability"))
    if track == "BASIC" and (optimistic is None or conservative is None):
        raise ValueError("basic research requires probabilities")

    raw_criteria = payload.get("criteria")
    if not isinstance(raw_criteria, list) or not raw_criteria:
        raise ValueError("criteria are missing")
    criteria = []
    seen_codes = set()
    for item in raw_criteria:
        if not isinstance(item, dict):
            raise ValueError("invalid criterion")
        code = str(item.get("code") or "").strip()
        if code not in CRITERIA_CODES or code in seen_codes:
            raise ValueError(f"invalid or duplicated criterion: {code}")
        seen_codes.add(code)
        try:
            score = max(0, min(10, round(float(item.get("score")))))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid criterion score") from exc
        criteria.append(
            {
                "code": code,
                "title": str(item.get("title") or CRITERIA_TITLES[code]),
                "score": score,
                "evidence": str(item.get("evidence") or "")[:4000],
                "gap": str(item.get("gap") or "")[:2000],
            }
        )

    if len(criteria) != len(CRITERIA_CODES):
        raise ValueError("all five criteria are required")
    decision = "ADVISORY" if track == "APPLIED" else ("RETURN" if conservative < 50 else "PASS")
    return {
        "decision": decision,
        "subjournal_probability": optimistic,
        "conservative_probability": conservative,
        "paper_tier": str(payload.get("paper_tier") or "")[:500],
        "criteria": criteria,
        "risks": [str(item)[:1000] for item in (payload.get("risks") or [])[:20] if str(item).strip()],
        "recommendations": [
            str(item)[:1000] for item in (payload.get("recommendations") or [])[:20] if str(item).strip()
        ],
    }


def _append_agent_event(session, request_id, action):
    """Append the session-ready fact used by existing Agent event replay."""
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        seq = locked.run_events.count() + 1
        return ResearchAgentRunEvent.objects.create(
            session=locked,
            run_id=locked.run_id,
            seq=seq,
            event_type="AI_ACTION",
            payload={"action": action},
            request_id=request_id,
        )


def _create_agent_session(stage, actor, node, request_id):
    """Create one session through the already-governed SD/Synlora channels."""
    workspace = stage.workspace
    backend_connection = resolve_science_discovery_connection(workspace, actor)
    if backend_connection is not None:
        orchestrated = create_science_discovery_session(
            workspace=workspace,
            user=actor,
            node=node,
            request_id=request_id,
            connection=backend_connection,
        )
        provider = ResearchAgentSession.Provider.SCIENCE_DISCOVERY
    else:
        # Reuse the exact Agent BFF assembly and context-token implementation.
        from plane.research.views.agent import create_synlora_runtime_session

        orchestrated = create_synlora_runtime_session(
            workspace=workspace,
            user=actor,
            node=node,
            request_id=request_id,
        )
        provider = ResearchAgentSession.Provider.SYNLORA
        backend_connection = None

    session = ResearchAgentSession.objects.create(
        workspace=workspace,
        user=actor,
        project_id=stage.chain.project_id,
        research_chain=stage.chain,
        chain_node=node,
        context_grant=orchestrated["grant"],
        status=ResearchAgentSession.Status.READY,
        synlora_session_id=orchestrated.get("synlora_session_id", ""),
        provider=provider,
        backend_connection=backend_connection,
        sd_project_id=orchestrated.get("sd_project_id", ""),
        sd_session_id=orchestrated.get("sd_session_id", ""),
        delegated_subject=orchestrated.get("delegated_subject", ""),
        context_token_encrypted=orchestrated.get("context_token_encrypted", ""),
        assembly=orchestrated["assembly"],
        request_id=request_id,
        payload_hash=uuid.uuid4().hex,
        created_by=actor,
    )
    _append_agent_event(session, f"event:{request_id}", "stage_evaluation.session.ready")
    return session


def _start_agent_run(session, prompt, request_id):
    """Submit the evaluation prompt without exposing provider credentials."""
    if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
        client = ScienceDiscoveryClient(connection=session.backend_connection)
        remote_run_id = client.start_run(session_id=session.sd_session_id, content=prompt)
        session.sd_run_id = remote_run_id
    else:
        runtime = resolve_synlora_runtime(session.workspace, user=session.user)
        if runtime is None:
            raise _http_error(
                ResearchErrorCode.EVALUATION_RUNTIME_UNAVAILABLE,
                "No enabled SD/Synlora runtime is configured for this workspace.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        context = synlora_research_context(
            session.workspace,
            session.user,
            session.chain_node,
            session.context_grant,
        )
        remote_run_id = runtime.start_run(
            thread_id=session.synlora_session_id,
            content=prompt,
            request_id=request_id,
            research_context=context,
            context_token=decrypt_data(session.context_token_encrypted),
            external_run_id=str(session.run_id),
        )
        session.synlora_run_id = remote_run_id
    session.status = ResearchAgentSession.Status.STREAMING
    session.last_error = ""
    session.save(update_fields=["sd_run_id", "synlora_run_id", "status", "last_error", "updated_at"])
    return session


def _remote_cursor(session):
    values = [
        int(event.payload.get("remote_seq") or 0)
        for event in session.run_events.all()
        if isinstance(event.payload, dict)
    ]
    return max(values or [0])


def _pull_agent_events(session):
    """Pull provider events only while the existing session has not converged."""
    if session.status == ResearchAgentSession.Status.READY:
        return
    cursor = _remote_cursor(session)
    if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
        client = ScienceDiscoveryClient(connection=session.backend_connection)
        remote_events = client.events(
            session_id=session.sd_session_id,
            run_id=session.sd_run_id,
            after_seq=cursor,
        )
        project_science_discovery_events(session, remote_events)
    else:
        runtime = resolve_synlora_runtime(session.workspace, user=session.user)
        if runtime is None:
            return
        remote_events, _cursor, _terminal = runtime.pull_events(
            session_id=session.synlora_session_id,
            after_seq=cursor,
        )
        project_science_discovery_events(session, remote_events, source_system="SYNLORA")
    session.refresh_from_db()


def _model_version(session):
    for event in session.run_events.order_by("-seq"):
        payload = event.payload if isinstance(event.payload, dict) else {}
        if payload.get("remote_type") == "model.usage":
            for key in ("model", "model_id", "model_name", "version", "provider_model"):
                if payload.get(key):
                    return str(payload[key])[:128]
    return ""


def _final_output(session):
    for event in session.run_events.filter(event_type="OUTPUT").order_by("-seq"):
        content = str((event.payload or {}).get("content") or "").strip()
        if content:
            return content
    return ""


def _mark_failed(evaluation, error_code):
    evaluation.status = ResearchChainStageEvaluation.Status.FAILED
    evaluation.error_code = error_code[:128]
    evaluation.save(update_fields=["status", "error_code", "updated_at"])
    return evaluation


def refresh_stage_evaluation(evaluation):
    """Pull the pinned Agent run and normalize a completed evaluation.

    Args:
        evaluation: The RUNNING stage evaluation record.

    Returns:
        The refreshed evaluation in READY, FAILED, or RUNNING state.
    """
    if evaluation.status != ResearchChainStageEvaluation.Status.RUNNING:
        return evaluation
    evaluation.agent_session.refresh_from_db()
    session = evaluation.agent_session
    if session.status == ResearchAgentSession.Status.CLOSED:
        return _mark_failed(evaluation, "evaluation_cancelled")
    if timezone.now() - evaluation.created_at >= timezone.timedelta(minutes=EVALUATION_TIMEOUT_MINUTES):
        return _mark_failed(evaluation, "evaluation_timeout")

    try:
        _pull_agent_events(session)
    except (ScienceDiscoveryError, SynloraRuntimeError):
        # The next GET/Celery pass retries; only an explicit terminal run is failure.
        return evaluation

    evaluation.model_version = _model_version(session) or evaluation.model_version
    if session.status == ResearchAgentSession.Status.READY:
        try:
            evaluation.result = parse_evaluation_output(_final_output(session), evaluation.track)
            evaluation.status = ResearchChainStageEvaluation.Status.READY
            evaluation.error_code = ""
            evaluation.save(update_fields=["result", "status", "error_code", "model_version", "updated_at"])
        except (TypeError, ValueError, json.JSONDecodeError):
            _mark_failed(evaluation, "evaluation_invalid_output")
    elif session.status in (ResearchAgentSession.Status.DEGRADED, ResearchAgentSession.Status.ERROR):
        _mark_failed(evaluation, session.last_error or "evaluation_run_failed")
    else:
        evaluation.save(update_fields=["model_version", "updated_at"])
    return evaluation


def create_stage_evaluation(stage, actor, *, track, request_id):
    """Create and submit one stage-three evaluation through an Agent session.

    Args:
        stage: The TOPIC_EVALUATION stage approval.
        actor: The authenticated chain writer.
        track: ``BASIC`` or ``APPLIED`` research track.
        request_id: Caller idempotency key.

    Returns:
        The created or replayed evaluation record.
    """
    normalized_track = str(track or "").strip().upper()
    if normalized_track not in ResearchChainStageEvaluation.Track.values:
        raise _http_error(
            ResearchErrorCode.CHAIN_INVALID,
            "track must be BASIC or APPLIED.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if stage.stage_code != "TOPIC_EVALUATION":
        raise _http_error(
            ResearchErrorCode.CHAIN_STAGE_PRECHECK_ONLY_TOPIC_EVALUATION,
            "Stage evaluation is only available for TOPIC_EVALUATION.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if stage.status not in EDITABLE_STAGE_STATUSES:
        raise _http_error(
            ResearchErrorCode.CHAIN_STAGE_MATERIAL_READ_ONLY,
            "Stage evaluation can only run before submission or after a return.",
            status.HTTP_409_CONFLICT,
        )
    missing = missing_material_requirements(stage)
    if missing:
        raise _http_error(
            ResearchErrorCode.CHAIN_STAGE_MATERIAL_INCOMPLETE,
            "All required stage materials must be submitted before evaluation.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            missing=missing,
        )

    existing = ResearchChainStageEvaluation.objects.filter(request_id=request_id).first()
    if existing is not None:
        if existing.stage_id != stage.pk or existing.track != normalized_track:
            raise _http_error(
                ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                "request_id was already used by another evaluation.",
                status.HTTP_409_CONFLICT,
            )
        return existing

    running = stage.evaluations.filter(
        track=normalized_track,
        status=ResearchChainStageEvaluation.Status.RUNNING,
        material_version=stage_material_version(stage),
    ).first()
    if running is not None:
        return running

    precheck = create_stage_precheck(stage, actor, request_id=f"precheck-{uuid.uuid4().hex}")
    snapshot = evaluation_material_snapshot(stage)
    node = stage.chain.nodes.filter(node_type="TOPIC_EVALUATION", deleted_at__isnull=True).first()
    if node is None:
        node = stage.submitted_node
    if node is None:
        raise _http_error(
            ResearchErrorCode.CHAIN_INVALID,
            "Create the stage-three business node before evaluation.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    try:
        session = _create_agent_session(stage, actor, node, request_id)
        evaluation = ResearchChainStageEvaluation.objects.create(
            stage=stage,
            agent_session=session,
            track=normalized_track,
            status=ResearchChainStageEvaluation.Status.RUNNING,
            input_snapshot=snapshot,
            material_version=precheck_material_version(precheck),
            prompt_version=EVALUATION_PROMPT_VERSION,
            provider=session.provider,
            request_id=request_id,
            created_by=actor,
        )
        _start_agent_run(session, build_evaluation_prompt(normalized_track, snapshot), request_id)
    except ChainStageRuleError:
        raise
    except (ScienceDiscoveryError, SynloraRuntimeError) as exc:
        if "evaluation" in locals():
            _mark_failed(evaluation, exc.code)
        raise _http_error(
            ResearchErrorCode.EVALUATION_RUNTIME_UNAVAILABLE,
            "No enabled SD/Synlora runtime is configured for this workspace.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from exc

    if stage.status == "NOT_STARTED":
        stage.status = "IN_PROGRESS"
        stage.save(update_fields=["status", "updated_at"])
    record_audit_event(
        workspace=stage.workspace,
        action=ResearchAuditAction.CHAIN_STAGE_EVALUATION_CREATE,
        resource_type=ResearchResourceType.RESEARCH_CHAIN_STAGE,
        resource_id=stage.pk,
        actor=actor,
        metadata={"evaluation_id": str(evaluation.pk), "provider": session.provider, "track": evaluation.track},
    )
    return evaluation


def precheck_material_version(precheck):
    """Read the material version captured by one precheck."""
    checks = precheck.checks if isinstance(precheck.checks, list) else []
    for check in checks:
        if isinstance(check, dict) and check.get("material_version"):
            return str(check["material_version"])
    return ""


def latest_stage_evaluation(stage):
    """Return the newest evaluation for a stage."""
    return stage.evaluations.select_related("agent_session").first()


def evaluation_allows_submission(evaluation, material_version):
    """Apply the stage-three AI gate without blocking applied research.

    Args:
        evaluation: Latest stage evaluation record.
        material_version: Current material version.

    Returns:
        True when submission may continue.
    """
    if evaluation is None or evaluation.material_version != material_version:
        return False
    if evaluation.status != ResearchChainStageEvaluation.Status.READY:
        return False
    if evaluation.track == ResearchChainStageEvaluation.Track.APPLIED:
        return True
    result = evaluation.result if isinstance(evaluation.result, dict) else {}
    try:
        return float(result.get("conservative_probability")) >= 50
    except (TypeError, ValueError):
        return False
