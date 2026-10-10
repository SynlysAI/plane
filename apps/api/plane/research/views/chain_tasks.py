# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research Chain node task API."""

from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ResearchChainNodeTask
from plane.research.serializers import ResearchChainNodeTaskSerializer
from plane.research.services.chain_tasks import (
    ChainTaskConflictError,
    ChainTaskPermissionError,
    ChainTaskStateError,
    ChainTaskValidationError,
    cancel_task,
    complete_task,
    create_task,
    list_tasks,
    return_task,
    submit_task,
    update_task,
)
from plane.research.services.idempotency import payload_hash, request_id_from
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.views.base import ResearchAPIView
from plane.research.views.chain_foundation import (
    _chain_readonly_error,
    _disabled,
    _envelope,
    _flag_enabled,
    _visible_chain,
)

TASK_SCHEMA_VERSION = "research-chain-task.v1"


def _error_response(exception):
    """Convert a domain task exception into the research error envelope."""
    if isinstance(exception, ChainTaskPermissionError):
        return research_error(ResearchErrorCode.PERMISSION_DENIED, str(exception), status.HTTP_403_FORBIDDEN)
    if isinstance(exception, ChainTaskStateError):
        return research_error(ResearchErrorCode.INVALID_TRANSITION, str(exception), status.HTTP_409_CONFLICT)
    if isinstance(exception, ChainTaskConflictError):
        return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, str(exception), status.HTTP_409_CONFLICT)
    return research_error(ResearchErrorCode.CHAIN_INVALID, str(exception), status.HTTP_422_UNPROCESSABLE_ENTITY)


def _payload_with_request_id(request, request_id):
    """Merge an idempotency header with the JSON body for stable hashing."""
    if hasattr(request.data, "dict"):
        payload = request.data.dict()
    else:
        payload = dict(request.data or {})
    payload["request_id"] = request_id
    return payload


def _serializer_error(serializer):
    """Return the first serializer message without leaking field internals."""
    field, errors = next(serializer.errors.items())
    message = errors[0] if isinstance(errors, list) else str(errors)
    return research_error(
        ResearchErrorCode.CHAIN_INVALID,
        f"{field}: {message}" if field != "non_field_errors" else str(message),
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def _node_context(view, request, slug, chain_id, node_id):
    """Resolve a visible workspace, chain, and node for the dispatched view."""
    workspace, error = view.get_workspace(section="research_chain")
    if error:
        return None, None, None, error
    if not _flag_enabled(workspace):
        return None, None, None, _disabled()
    chain = _visible_chain(workspace, request.user, chain_id)
    if chain is None:
        return None, None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
    node = chain.nodes.filter(pk=node_id).first()
    if node is None:
        return None, None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research node not found.")
    return workspace, chain, node, None


def _task_context(view, request, slug, chain_id, node_id, task_id):
    """Resolve one visible task attached to the requested chain node."""
    workspace, chain, node, error = _node_context(view, request, slug, chain_id, node_id)
    if error:
        return None, None, None, error
    task = (
        ResearchChainNodeTask.objects.filter(workspace=workspace, chain=chain, node=node, pk=task_id)
        .select_related("workspace", "chain", "node", "assignee", "assigned_by")
        .first()
    )
    if task is None:
        return None, None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research task not found.")
    return workspace, chain, node, task


class ResearchChainNodeTaskListCreateEndpoint(ResearchAPIView):
    """List and create tasks under one visible Research Chain node."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _context(self, request, slug, chain_id, node_id):
        return _node_context(self, request, slug, chain_id, node_id)

    def get(self, request, slug, chain_id, node_id):
        workspace, chain, node, error = self._context(request, slug, chain_id, node_id)
        if error:
            return error
        try:
            tasks = list_tasks(
                workspace=workspace,
                chain=chain,
                node=node,
                status=request.GET.get("status"),
                assignee_id=request.GET.get("assignee"),
                due_before=request.GET.get("due_before"),
            )
        except ChainTaskValidationError as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchChainNodeTaskSerializer(tasks, many=True, context={"request": request}).data,
                request_id=request_id_from(request),
                schema_version=TASK_SCHEMA_VERSION,
            )
        )

    def post(self, request, slug, chain_id, node_id):
        workspace, chain, node, error = self._context(request, slug, chain_id, node_id)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        serializer = ResearchChainNodeTaskSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return _serializer_error(serializer)
        payload = _payload_with_request_id(request, request_id)
        try:
            task, created = create_task(
                workspace=workspace,
                chain=chain,
                node=node,
                actor=request.user,
                payload=payload,
                request=request,
            )
        except (
            ChainTaskPermissionError,
            ChainTaskStateError,
            ChainTaskConflictError,
            ChainTaskValidationError,
        ) as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchChainNodeTaskSerializer(task, context={"request": request}).data,
                request_id=request_id,
                schema_version=TASK_SCHEMA_VERSION,
            ),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ResearchChainNodeTaskDetailEndpoint(ResearchAPIView):
    """Read or edit one task without exposing node transition controls."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _context(self, request, slug, chain_id, node_id, task_id):
        return _task_context(self, request, slug, chain_id, node_id, task_id)

    def get(self, request, slug, chain_id, node_id, task_id):
        _, _, _, task_or_error = self._context(request, slug, chain_id, node_id, task_id)
        if isinstance(task_or_error, Response):
            return task_or_error
        task = task_or_error
        return Response(
            _envelope(
                data=ResearchChainNodeTaskSerializer(task, context={"request": request}).data,
                request_id=request_id_from(request),
                schema_version=TASK_SCHEMA_VERSION,
            )
        )

    def patch(self, request, slug, chain_id, node_id, task_id):
        _, chain, _, task_or_error = self._context(request, slug, chain_id, node_id, task_id)
        if isinstance(task_or_error, Response):
            return task_or_error
        task = task_or_error
        readonly_error = _chain_readonly_error(chain)
        if readonly_error:
            return readonly_error
        serializer = ResearchChainNodeTaskSerializer(
            task, data=request.data, partial=True, context={"request": request}
        )
        if not serializer.is_valid():
            return _serializer_error(serializer)
        try:
            updated_task = update_task(
                task=task,
                actor=request.user,
                payload=serializer.validated_data,
                request=request,
            )
        except (
            ChainTaskPermissionError,
            ChainTaskStateError,
            ChainTaskConflictError,
            ChainTaskValidationError,
        ) as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchChainNodeTaskSerializer(updated_task, context={"request": request}).data,
                request_id=request_id_from(request),
                schema_version=TASK_SCHEMA_VERSION,
            )
        )


class ResearchChainNodeTaskActionEndpoint(ResearchAPIView):
    """Run one validated task lifecycle action."""

    nav_capability = NAV_RESEARCH_CHAIN

    ACTIONS = {
        "submit": submit_task,
        "return": return_task,
        "complete": complete_task,
        "cancel": cancel_task,
    }

    def post(self, request, slug, chain_id, node_id, task_id, action):
        if action not in self.ACTIONS:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "Unsupported task action.",
                status.HTTP_404_NOT_FOUND,
            )
        _workspace, _chain, _node, task_or_error = _task_context(self, request, slug, chain_id, node_id, task_id)
        if isinstance(task_or_error, Response):
            return task_or_error
        task = task_or_error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        payload = _payload_with_request_id(request, request_id)
        digest = payload_hash(payload)
        kwargs = {
            "task": task,
            "actor": request.user,
            "request_id": request_id,
            "content_hash": digest,
            "request": request,
        }
        if action in {"return", "cancel"}:
            kwargs["reason"] = request.data.get("reason")
        elif action == "complete":
            kwargs["comment"] = request.data.get("comment", "")
        try:
            updated_task, _changed = self.ACTIONS[action](**kwargs)
        except (
            ChainTaskPermissionError,
            ChainTaskStateError,
            ChainTaskConflictError,
            ChainTaskValidationError,
        ) as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchChainNodeTaskSerializer(updated_task, context={"request": request}).data,
                request_id=request_id,
                schema_version=TASK_SCHEMA_VERSION,
            )
        )
