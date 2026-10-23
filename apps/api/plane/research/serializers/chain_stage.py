"""Serializers for the Research Chain thirteen-stage approval API."""

from rest_framework import serializers

from plane.db.models import (
    ResearchChainStage,
    ResearchChainStageMaterialItem,
    ResearchChainStagePrecheck,
    ResearchChainStageReviewAction,
)
from plane.research.services.chain_stage_approvals import (
    CHAIN_STAGE_PI_POLICIES,
    ChainStageRuleError,
    material_state,
    precheck_material_version,
    resolve_advisor,
    resolve_principal,
    stage_material_version,
)
from plane.research.services.chain_tasks import chain_writer
from plane.research.utils.action_capabilities import capability_map
from plane.research.utils.errors import ResearchErrorCode


STAGE_ACTIONS = ("view", "edit_materials", "remove_material", "precheck", "submit", "review")


def _user_lite(user):
    """Project a reviewer without exposing unrelated account fields."""
    if user is None:
        return None
    return {"id": str(user.id), "display_name": user.display_name or user.email, "email": user.email}


def _safe_reviewer(resolver, chain):
    """Resolve a reviewer while allowing unreadable configuration in GETs."""
    try:
        return _user_lite(resolver(chain)), None
    except ChainStageRuleError as error:
        return None, error.message


class ResearchChainStageMaterialItemSerializer(serializers.ModelSerializer):
    """Expose one submitted stage material item."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainStageMaterialItem
        fields = [
            "schema_version",
            "id",
            "stage",
            "requirement",
            "title",
            "description",
            "source_node",
            "external_reference",
            "request_id",
            "created_at",
            "updated_at",
        ]

    def get_schema_version(self, _obj):
        return "research-chain-stage-material.v1"


class ResearchChainStageReviewActionSerializer(serializers.ModelSerializer):
    """Expose one immutable stage review decision."""

    schema_version = serializers.SerializerMethodField()
    reviewer_detail = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainStageReviewAction
        fields = [
            "schema_version",
            "id",
            "stage",
            "attempt_no",
            "reviewer",
            "reviewer_detail",
            "reviewer_role",
            "action",
            "comment",
            "escalated_to_pi",
            "material_snapshot",
            "declaration_snapshot",
            "request_id",
            "created_at",
        ]

    def get_schema_version(self, _obj):
        return "research-chain-stage-review-action.v1"

    def get_reviewer_detail(self, obj):
        return _user_lite(obj.reviewer)


class ResearchChainStagePrecheckSerializer(serializers.ModelSerializer):
    """Expose one advisory stage precheck."""

    schema_version = serializers.SerializerMethodField()
    material_version = serializers.SerializerMethodField()
    is_current = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainStagePrecheck
        fields = [
            "schema_version",
            "id",
            "stage",
            "status",
            "summary",
            "material_version",
            "is_current",
            "checks",
            "recommendations",
            "generated_by",
            "model_version",
            "request_id",
            "created_at",
        ]

    def get_schema_version(self, _obj):
        return "research-chain-stage-precheck.v1"

    def get_material_version(self, obj):
        return precheck_material_version(obj)

    def get_is_current(self, obj):
        version = precheck_material_version(obj)
        return bool(version) and version == stage_material_version(obj.stage)


class ResearchChainStageSerializer(serializers.ModelSerializer):
    """Project one stage with its materials, route, history and capabilities."""

    schema_version = serializers.SerializerMethodField()
    pi_policy = serializers.SerializerMethodField()
    materials = serializers.SerializerMethodField()
    review_actions = serializers.SerializerMethodField()
    latest_precheck = serializers.SerializerMethodField()
    advisor = serializers.SerializerMethodField()
    principal_investigator = serializers.SerializerMethodField()
    current_review_step = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainStage
        fields = [
            "schema_version",
            "id",
            "chain",
            "stage_code",
            "sort_order",
            "status",
            "pi_policy",
            "requires_pi",
            "escalation_reason",
            "attempt_count",
            "submitted_node",
            "submitted_at",
            "approved_at",
            "materials",
            "review_actions",
            "latest_precheck",
            "advisor",
            "principal_investigator",
            "current_review_step",
            "capabilities",
            "created_at",
            "updated_at",
        ]

    def get_schema_version(self, _obj):
        return "research-chain-stage.v1"

    def get_pi_policy(self, obj):
        return CHAIN_STAGE_PI_POLICIES[obj.stage_code]

    def get_materials(self, obj):
        return material_state(obj)

    def get_review_actions(self, obj):
        return ResearchChainStageReviewActionSerializer(
            obj.review_actions.all(),
            many=True,
        ).data

    def get_latest_precheck(self, obj):
        precheck = obj.prechecks.first()
        return ResearchChainStagePrecheckSerializer(precheck).data if precheck else None

    def get_advisor(self, obj):
        user, error = self._cached_reviewer("advisor", resolve_advisor, obj.chain)
        return {"user": user, "error": error}

    def get_principal_investigator(self, obj):
        user, error = self._cached_reviewer("principal", resolve_principal, obj.chain)
        return {"user": user, "error": error}

    def get_current_review_step(self, obj):
        if obj.status == "AWAITING_ADVISOR":
            return "ADVISOR"
        if obj.status == "AWAITING_PI":
            return "PI"
        return None

    def get_capabilities(self, obj):
        """Return explicit stage actions for the requesting actor."""
        actor = self.context.get("actor")
        if actor is None:
            return capability_map(STAGE_ACTIONS, {})
        writable = self._cached_writable(obj, actor)
        editable = writable and obj.status in ("NOT_STARTED", "IN_PROGRESS", "NEEDS_REVISION")
        reviewer_allowed = False
        reasons = {}
        if obj.status == "AWAITING_ADVISOR":
            reviewer, reviewer_error = self._cached_reviewer("advisor", resolve_advisor, obj.chain)
            reviewer_allowed = reviewer is not None and str(reviewer.get("id")) == str(actor.id)
            if reviewer_error:
                reasons["review"] = {
                    "reason_code": ResearchErrorCode.CHAIN_STAGE_REVIEWER_NOT_CONFIGURED,
                    "reason": reviewer_error,
                }
        elif obj.status == "AWAITING_PI":
            reviewer, reviewer_error = self._cached_reviewer("principal", resolve_principal, obj.chain)
            reviewer_allowed = reviewer is not None and str(reviewer.get("id")) == str(actor.id)
            if reviewer_error:
                reasons["review"] = {
                    "reason_code": ResearchErrorCode.CHAIN_STAGE_REVIEWER_NOT_CONFIGURED,
                    "reason": reviewer_error,
                }
        decisions = {
            "view": True,
            "edit_materials": editable,
            "remove_material": editable,
            "precheck": editable and obj.stage_code == "TOPIC_EVALUATION",
            "submit": editable,
            "review": obj.chain.status == "ACTIVE" and reviewer_allowed,
        }
        return capability_map(STAGE_ACTIONS, decisions, reasons=reasons)

    def _cached_reviewer(self, key, resolver, chain):
        """Resolve one reviewer once per serialized chain.

        Args:
            key: Cache key for the reviewer role.
            resolver: Advisor or principal resolver.
            chain: The Research Chain shared by the serialized stages.

        Returns:
            A reviewer projection and optional configuration error.
        """
        cache = self.context.setdefault("reviewer_cache", {})
        if key not in cache:
            cache[key] = _safe_reviewer(resolver, chain)
        return cache[key]

    def _cached_writable(self, obj, actor):
        """Resolve chain write permission once per serialized chain.

        Args:
            obj: The stage being serialized.
            actor: The requesting user.

        Returns:
            Whether the actor can write the stage's chain.
        """
        if "writable" not in self.context:
            self.context["writable"] = obj.chain.status == "ACTIVE" and chain_writer(obj.workspace, actor, obj.chain)
        return self.context["writable"]
