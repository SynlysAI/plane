"""发布科研组织成员边界前的只读账号审计命令。"""

import json
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import (
    MentorBinding,
    OrgUnitMember,
    ProjectMember,
    ResearchProjectProfile,
    ResearchUserProfile,
    StageReviewerAssignment,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.license.models import InstanceAdmin
from plane.research.utils.capabilities import org_signal_workspace
from plane.research.utils.org import active_membership_q
from plane.utils.administrative_projects import research_project_ids

WORKSPACE_ADMIN_ROLE = 20


class Command(BaseCommand):
    help = "List workspace accounts with legacy research signals but no active research organization membership"

    def add_arguments(self, parser):
        parser.add_argument("workspace_slug", help="workspace slug")
        parser.add_argument("--json", action="store_true", help="output machine-readable JSON")

    def handle(self, *args: Any, **options: Any):
        workspace = Workspace.objects.filter(slug=options["workspace_slug"]).first()
        if workspace is None:
            raise CommandError("Workspace not found.")

        accounts = self._accounts(workspace)
        if options["json"]:
            self.stdout.write(
                json.dumps(
                    {
                        "workspace": workspace.slug,
                        "accounts": accounts,
                    },
                    ensure_ascii=False,
                )
            )
            return

        self.stdout.write(f"Research membership boundary audit: {workspace.slug}")
        if not accounts:
            self.stdout.write(
                self.style.SUCCESS("No legacy research identity lacks an active organization membership.")
            )
            return
        for account in accounts:
            self.stdout.write(f"{account['email']:<36} {', '.join(account['reasons'])}")
        self.stdout.write(
            self.style.WARNING(f"{len(accounts)} account(s) need an active organization membership before release.")
        )

    def _accounts(self, workspace):
        """返回会因新边界失去科研入口的账号及原因。

        Args:
            workspace: 待审计的工作区。

        Returns:
            按邮箱排序的账号审计列表。
        """
        memberships = list(
            WorkspaceMember.objects.filter(
                workspace=workspace,
                member__is_active=True,
                is_active=True,
                deleted_at__isnull=True,
            ).select_related("member")
        )
        signal_workspace = org_signal_workspace(workspace)
        workspace_member_ids = {membership.member_id for membership in memberships}
        org_member_ids = set(
            OrgUnitMember.objects.filter(
                active_membership_q(),
                workspace=signal_workspace,
                org_unit__workspace=signal_workspace,
                org_unit__deleted_at__isnull=True,
                org_unit__is_active=True,
            ).values_list("user_id", flat=True)
        )

        instance_admin_ids = set(InstanceAdmin.objects.values_list("user_id", flat=True))
        setting = WorkspaceResearchSetting.objects.filter(workspace=workspace).first()
        main_pi_id = setting.main_pi_id if setting is not None else None
        profile_ids = set(
            ResearchUserProfile.objects.filter(
                user_id__in=workspace_member_ids,
                deleted_at__isnull=True,
            ).values_list("user_id", flat=True)
        )
        project_owner_ids = set(
            ResearchProjectProfile.objects.filter(workspace=workspace).values_list("owner_id", flat=True)
        )
        research_project_member_ids = set(
            ProjectMember.objects.filter(
                workspace=workspace,
                project_id__in=research_project_ids(),
                is_active=True,
                deleted_at__isnull=True,
            ).values_list("member_id", flat=True)
        )
        mentor_ids = set(
            MentorBinding.objects.filter(workspace=workspace, deleted_at__isnull=True).values_list(
                "mentor_id", flat=True
            )
        )
        mentee_ids = set(
            MentorBinding.objects.filter(workspace=workspace, deleted_at__isnull=True).values_list(
                "mentee_id", flat=True
            )
        )
        reviewer_ids = set(
            StageReviewerAssignment.objects.filter(
                stage_instance__workspace=workspace,
                is_active=True,
                superseded_at__isnull=True,
                deleted_at__isnull=True,
            ).values_list("reviewer_id", flat=True)
        )

        accounts = []
        for membership in memberships:
            user_id = membership.member_id
            if user_id in org_member_ids:
                continue
            reasons = []
            if membership.role == WORKSPACE_ADMIN_ROLE:
                reasons.append("workspace_admin")
            if user_id in instance_admin_ids:
                reasons.append("instance_admin")
            if user_id == main_pi_id:
                reasons.append("main_pi")
            if user_id in profile_ids:
                reasons.append("research_profile")
            if user_id in project_owner_ids or user_id in research_project_member_ids:
                reasons.append("research_project_relation")
            if user_id in mentor_ids or user_id in mentee_ids:
                reasons.append("mentor_relation")
            if user_id in reviewer_ids:
                reasons.append("stage_reviewer")
            if reasons:
                accounts.append(
                    {
                        "id": str(user_id),
                        "email": membership.member.email,
                        "display_name": membership.member.display_name,
                        "reasons": reasons,
                    }
                )
        return sorted(accounts, key=lambda item: item["email"])
