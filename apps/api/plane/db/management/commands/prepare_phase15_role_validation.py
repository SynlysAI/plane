"""Create and clean the Phase 1.5 role-validation fixture."""

import hashlib
import json
import secrets

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from plane.research.services.group_knowledge import ensure_group_knowledge_binding
from plane.db.models import (
    DEFAULT_STATES,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ProjectIdentifier,
    ProjectMember,
    ResearchChain,
    ResearchChainNode,
    ResearchGroupKnowledgeBinding,
    ResearchKnowledgeRequest,
    ResearchProjectProfile,
    ResearchUserProfile,
    State,
    User,
    Workspace,
    WorkspaceMember,
)


FIXTURE_PREFIX = "P15-MOCK-"
INDUSTRY_EMAIL = "phase15.industry.owner@ai4ms.local"
BASIC_EMAIL = "phase15.basic.owner@ai4ms.local"
GUEST_EMAIL = "phase15.guest@ai4ms.local"
INDUSTRY_UNIT_NAME = "Phase 1.5 产业化验证单元"
BASIC_UNIT_NAME = "Phase 1.5 基础研究验证单元"
PASSWORD_LENGTH = 18


class Command(BaseCommand):
    """Prepare a repeatable, removable role-validation fixture."""

    help = "Prepare or clean the Phase 1.5 role-validation mock fixture."

    def add_arguments(self, parser):
        """Register apply/cleanup options for the fixture command."""
        parser.add_argument("--workspace", default="public")
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--cleanup", action="store_true")
        parser.add_argument("--reset-passwords", action="store_true")
        parser.add_argument("--json", action="store_true")

    def handle(self, *args, **options):
        """Apply or clean the Phase 1.5 role-validation fixture.

        Args:
            *args: Unused positional arguments from Django.
            **options: Parsed command-line options.
        """
        if options["apply"] == options["cleanup"]:
            raise CommandError("请且只能指定 --apply 或 --cleanup")
        workspace = Workspace.objects.filter(slug=options["workspace"]).first()
        if workspace is None:
            raise CommandError(f"工作区不存在：{options['workspace']}")
        result = (
            self._cleanup(workspace)
            if options["cleanup"]
            else self._apply(workspace, options["reset_passwords"])
        )
        output = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True)
        if options["json"]:
            self.stdout.write(output)
        else:
            self.stdout.write(self.style.SUCCESS(output))

    @staticmethod
    def _password():
        """Generate a strong one-time test password.

        Returns:
            A generated password string for Phase 1.5 test accounts.
        """
        return f"P15!{secrets.token_urlsafe(PASSWORD_LENGTH)[:PASSWORD_LENGTH]}"

    def _user(self, email, display_name, category, *, reset_password=False):
        """Get or create a fixture user and optionally reset the password.

        Args:
            email: Account email.
            display_name: Display name written onto the user.
            category: Research user category.
            reset_password: Whether to rotate the password for an existing user.

        Returns:
            Tuple of (user, plaintext password or None, created flag).
        """
        user = User.objects.filter(email__iexact=email).first()
        created = user is None
        password = None
        if user is None:
            password = self._password()
            user = User(
                email=email,
                username=email,
                display_name=display_name,
                first_name=display_name,
                is_active=True,
            )
            user.set_password(password)
            user.is_password_reset_required = True
            user.save()
        elif reset_password:
            password = self._password()
            user.set_password(password)
            user.is_password_reset_required = True
            user.save(update_fields=["password", "is_password_reset_required", "updated_at"])
        ResearchUserProfile.objects.update_or_create(
            user=user,
            defaults={"category": category, "group_label": "Phase 1.5 Role Validation"},
        )
        return user, password, created

    def _member(self, workspace, user, role):
        """Ensure the user has a workspace membership with the given role.

        Args:
            workspace: Target workspace.
            user: Workspace member.
            role: Plane workspace role integer.

        Returns:
            The upserted WorkspaceMember row.
        """
        return WorkspaceMember.objects.update_or_create(
            workspace=workspace,
            member=user,
            defaults={"role": role, "is_active": True, "deleted_at": None},
        )[0]

    def _unit(self, workspace, name, business_category):
        """Get or create a fixture team for one business category.

        Args:
            workspace: Target workspace.
            name: Stable fixture unit name.
            business_category: Business category stored on the team.

        Returns:
            The fixture OrgUnit row.
        """
        unit = OrgUnit.objects.filter(workspace=workspace, name=name).first()
        if unit is None:
            unit = OrgUnit.objects.create(
                workspace=workspace,
                name=name,
                unit_type=OrgUnit.UnitType.TEAM,
                business_category=business_category,
                path="",
                created_by=User.objects.filter(email="admin@ai4ms.local").first(),
            )
            unit.path = f"/{unit.id.hex}/"
            unit.save(update_fields=["path", "unit_type", "business_category"])
        else:
            unit.unit_type = OrgUnit.UnitType.TEAM
            unit.business_category = business_category
            unit.save(update_fields=["unit_type", "business_category", "updated_at"])
        return unit

    def _apply(self, workspace, reset_passwords):
        """Create or refresh the mock project, chain, and role accounts.

        Args:
            workspace: Target workspace.
            reset_passwords: Whether to rotate passwords for baseline accounts.

        Returns:
            A JSON-serializable fixture summary.
        """
        with transaction.atomic():
            admin = User.objects.filter(email="admin@ai4ms.local").first() or User.objects.filter(
                is_superuser=True
            ).first()
            if admin is None:
                raise CommandError("找不到实例管理员")
            main_pi_id = workspace.research_setting.main_pi_id
            main_pi = User.objects.filter(pk=main_pi_id).first() if main_pi_id else None
            mentor_binding = (
                MentorBinding.objects.filter(
                    workspace=workspace,
                    deleted_at__isnull=True,
                    mentor__research_profile__category=ResearchUserProfile.Category.ADVISOR,
                    mentee__research_profile__category=ResearchUserProfile.Category.STUDENT,
                    mentee__research_org_memberships__workspace=workspace,
                    mentee__research_org_memberships__org_role=OrgUnitMember.OrgRole.REVIEWER,
                )
                .select_related("mentor", "mentee")
                .first()
            )
            if not main_pi or mentor_binding is None:
                raise CommandError("当前 public 基线缺少主 PI、直接导师或学生")
            mentor = mentor_binding.mentor
            student = mentor_binding.mentee
            selected = {"main_pi": main_pi, "mentor": mentor, "student": student, "admin": admin}
            passwords = {}
            if reset_passwords:
                for name, user in selected.items():
                    password = self._password()
                    user.set_password(password)
                    user.is_password_reset_required = True
                    user.save(update_fields=["password", "is_password_reset_required", "updated_at"])
                    passwords[name] = password
            industry, industry_password, industry_created = self._user(
                INDUSTRY_EMAIL,
                "Phase 1.5 产业化负责人",
                ResearchUserProfile.Category.PI,
                reset_password=reset_passwords,
            )
            basic, basic_password, basic_created = self._user(
                BASIC_EMAIL,
                "Phase 1.5 基础研究负责人",
                ResearchUserProfile.Category.PI,
                reset_password=reset_passwords,
            )
            guest, guest_password, guest_created = self._user(
                GUEST_EMAIL,
                "Phase 1.5 访客",
                ResearchUserProfile.Category.OTHER,
                reset_password=reset_passwords,
            )
            self._member(workspace, industry, 15)
            self._member(workspace, basic, 15)
            self._member(workspace, guest, 5)
            unit = self._unit(
                workspace,
                INDUSTRY_UNIT_NAME,
                OrgUnit.BusinessCategory.INDUSTRIALIZATION,
            )
            basic_unit = self._unit(
                workspace,
                BASIC_UNIT_NAME,
                OrgUnit.BusinessCategory.BASIC_RESEARCH,
            )
            OrgUnitMember.objects.update_or_create(
                workspace=workspace,
                org_unit=unit,
                user=industry,
                defaults={"org_role": OrgUnitMember.OrgRole.OWNER, "is_primary": True, "deleted_at": None},
            )
            OrgUnitMember.objects.update_or_create(
                workspace=workspace,
                org_unit=basic_unit,
                user=basic,
                defaults={"org_role": OrgUnitMember.OrgRole.OWNER, "is_primary": True, "deleted_at": None},
            )
            OrgUnitMember.objects.update_or_create(
                workspace=workspace,
                org_unit=unit,
                user=student,
                org_role=OrgUnitMember.OrgRole.REVIEWER,
                defaults={"deleted_at": None},
            )
            project_name = f"{FIXTURE_PREFIX}{timezone.localdate():%Y%m%d}"
            project = Project.objects.filter(workspace=workspace, name__startswith=project_name).first()
            if project is None:
                project = Project.objects.create(
                    workspace=workspace,
                    name=project_name,
                    identifier=f"P15{timezone.localdate():%m%d}",
                    network=0,
                    created_by=student,
                )
                ProjectIdentifier.objects.create(
                    workspace=workspace,
                    project=project,
                    name=project.identifier,
                )
                State.objects.bulk_create(
                    [
                        State(
                            name=state["name"],
                            color=state["color"],
                            project=project,
                            workspace=workspace,
                            sequence=state["sequence"],
                            group=state["group"],
                            default=state.get("default", False),
                            created_by=student,
                        )
                        for state in DEFAULT_STATES
                    ]
                )
                ProjectMember.objects.create(
                    project=project,
                    workspace=workspace,
                    member=student,
                    role=20,
                    created_by=student,
                )
                profile = ResearchProjectProfile.objects.create(
                    project=project,
                    workspace=workspace,
                    owner=student,
                    org_unit=unit,
                    research_type=ResearchProjectProfile.ResearchType.RESEARCH_PROJECT,
                    chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
                    chain_visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
                    created_by=student,
                )
                chain = ResearchChain.objects.create(
                    project=project,
                    workspace=workspace,
                    owner=student,
                    visibility="WORKSPACE",
                    request_id=f"phase15:{project.id}",
                    payload_hash=hashlib.sha256(str(project.id).encode()).hexdigest(),
                    created_by=student,
                )
                request = ensure_group_knowledge_binding(chain, student)
                node = ResearchChainNode.objects.create(
                    chain=chain,
                    node_type="LITERATURE_REVIEW",
                    title="Phase 1.5 分角色验证节点",
                    request_id=f"phase15-node:{chain.id}",
                    payload_hash=hashlib.sha256(str(chain.id).encode()).hexdigest(),
                    assignee=student,
                    created_by=student,
                )
            else:
                profile = project.research_profile
                chain = project.research_chain
                request = ensure_group_knowledge_binding(chain, student)
                node = chain.nodes.order_by("created_at").first()
            role_rows = [
                ("main_pi", main_pi, None),
                ("mentor", mentor, None),
                ("student", student, None),
                ("admin", admin, None),
                ("industry_owner", industry, industry_password),
                ("basic_research_owner", basic, basic_password),
                ("guest", guest, guest_password),
            ]
            return {
                "workspace": workspace.slug,
                "project_id": str(project.id),
                "profile_id": str(profile.id),
                "chain_id": str(chain.id),
                "knowledge_request_id": str(request.id),
                "node_id": str(node.id),
                "knowledge_request_state": request.state,
                "roles": {
                    name: {
                        "email": user.email,
                        "display_name": user.display_name,
                        "password": passwords.get(name, password),
                    }
                    for name, user, password in role_rows
                },
                "created": {
                    "industry_owner": industry_created,
                    "basic_research_owner": basic_created,
                    "guest": guest_created,
                },
                "mentor_binding_id": str(mentor_binding.id),
            }

    def _cleanup(self, workspace):
        """Remove fixture projects and generated role accounts.

        Args:
            workspace: Target workspace.

        Returns:
            A JSON-serializable cleanup summary.
        """
        projects = list(Project.objects.filter(workspace=workspace, name__startswith=FIXTURE_PREFIX))
        users = list(User.objects.filter(email__in=[INDUSTRY_EMAIL, BASIC_EMAIL, GUEST_EMAIL]))
        with transaction.atomic():
            for project in projects:
                chain = ResearchChain.objects.filter(project=project).first()
                if chain is not None:
                    ResearchKnowledgeRequest.objects.filter(chain=chain).delete()
                    ResearchChainNode.objects.filter(chain=chain).delete()
                    chain.delete()
                ResearchProjectProfile.objects.filter(project=project).delete()
                ProjectMember.objects.filter(project=project).delete()
                ProjectIdentifier.objects.filter(project=project).delete()
                State.objects.filter(project=project).delete()
                project.delete()
            OrgUnitMember.objects.filter(user__in=users, workspace=workspace).delete()
            WorkspaceMember.objects.filter(member__in=users, workspace=workspace).delete()
            ResearchUserProfile.objects.filter(user__in=users).delete()
            User.objects.filter(pk__in=[user.pk for user in users]).delete()
            ResearchGroupKnowledgeBinding.objects.filter(
                workspace=workspace,
                org_unit__name__in=[INDUSTRY_UNIT_NAME, BASIC_UNIT_NAME],
            ).delete()
            OrgUnit.objects.filter(
                workspace=workspace,
                name__in=[INDUSTRY_UNIT_NAME, BASIC_UNIT_NAME],
            ).delete()
        return {
            "workspace": workspace.slug,
            "removed_projects": len(projects),
            "removed_users": len(users),
            "status": "cleaned",
        }
