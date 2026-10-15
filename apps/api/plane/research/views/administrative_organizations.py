"""行政项目组织及组织成员管理接口。"""

from django.db import IntegrityError, transaction
from django.db.models import Prefetch, Q
from django.utils import timezone
from rest_framework.response import Response

from plane.app.permissions import ROLE
from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Project,
    ResearchChain,
    User,
    WorkspaceMember,
)
from plane.research.views.base import ResearchAPIView, parse_uuid
from plane.utils.administrative_projects import (
    get_or_create_default_administrative_organization,
    user_can_administer_administrative_organization,
    user_can_manage_administrative_organization,
    visible_administrative_projects,
)


class AdministrativeAPIView(ResearchAPIView):
    """不依赖科研模块开关与科研组织身份的行政接口基类。"""

    research_module_required = False
    research_membership_required = False

    def get_workspace(self, **kwargs):
        """解析行政接口工作区，并关闭科研工作区开关依赖。

        Args:
            **kwargs: 透传给科研基础视图的工作区参数。

        Returns:
            ``(workspace, error_response)``，二者恰好一个为空。
        """
        kwargs.setdefault("require_enabled", False)
        return super().get_workspace(**kwargs)


def _workspace_admin(user, workspace):
    """判断用户是否为工作区管理员或平台管理员。"""
    membership = WorkspaceMember.objects.filter(
        workspace=workspace,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
    ).first()
    return bool(membership and (membership.role == ROLE.ADMIN.value))


def _serialize_organization(organization, user, can_manage=None, visible_project_ids=None):
    """序列化组织及当前用户的管理能力。"""
    workspace = organization.workspace
    if can_manage is None:
        can_manage = user_can_manage_administrative_organization(user, workspace.slug, organization.id)
    if visible_project_ids is None:
        visible_project_ids = (
            visible_administrative_projects(user, workspace.slug)
            .filter(administrative_organization=organization)
            .values_list("id", flat=True)
        )
    member_relations = getattr(organization, "visible_members", None)
    if member_relations is None:
        member_relations = (
            organization.members.filter(is_active=True, deleted_at__isnull=True)
            .select_related("member")
            .order_by("member__email")
        )
    return {
        "id": str(organization.id),
        "name": organization.name,
        "is_default": organization.is_default,
        "created_by": str(organization.created_by_id) if organization.created_by_id else None,
        "can_manage": can_manage,
        "members": [
            {
                "id": str(item.member_id),
                "name": item.member.display_name or item.member.email,
                "email": item.member.email,
                "role": item.role,
            }
            for item in (member_relations if can_manage and not organization.is_default else [])
        ],
        "project_ids": [str(project_id) for project_id in visible_project_ids],
    }


class AdministrativeOrganizationListCreateEndpoint(AdministrativeAPIView):
    """列出、创建并重命名工作区内的行政组织。"""

    nav_capability = None

    def get(self, request, slug):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        workspace_admin = _workspace_admin(request.user, workspace)
        organizations = AdministrativeOrganization.objects.filter(workspace=workspace, deleted_at__isnull=True)
        if not workspace_admin:
            organizations = organizations.filter(
                Q(is_default=True)
                | Q(
                    members__member=request.user,
                    members__is_active=True,
                    members__deleted_at__isnull=True,
                )
            )
        organizations = (
            organizations.select_related("workspace", "created_by")
            .prefetch_related(
                Prefetch(
                    "members",
                    queryset=AdministrativeOrganizationMember.objects.filter(is_active=True, deleted_at__isnull=True)
                    .select_related("member")
                    .order_by("member__email"),
                    to_attr="visible_members",
                )
            )
            .distinct()
            .order_by("name", "created_at")
        )
        visible_projects_by_organization = {}
        for organization_id, project_id in (
            visible_administrative_projects(request.user, workspace.slug)
            .exclude(administrative_organization__isnull=True)
            .values_list("administrative_organization_id", "id")
        ):
            visible_projects_by_organization.setdefault(organization_id, []).append(project_id)
        managed_ids = set()
        if not workspace_admin:
            managed_ids = set(
                AdministrativeOrganizationMember.objects.filter(
                    workspace=workspace,
                    member=request.user,
                    role=AdministrativeOrganizationMember.Role.ADMIN,
                    is_active=True,
                    deleted_at__isnull=True,
                    organization__deleted_at__isnull=True,
                ).values_list("organization_id", flat=True)
            )
        return Response(
            [
                _serialize_organization(
                    item,
                    request.user,
                    can_manage=workspace_admin or item.id in managed_ids,
                    visible_project_ids=visible_projects_by_organization.get(item.id, []),
                )
                for item in organizations
            ]
        )

    def post(self, request, slug):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        name = str(request.data.get("name") or "").strip()
        if not name or len(name) > 255 or name == AdministrativeOrganization.PUBLIC_NAME:
            return Response({"message": "Organization name is invalid."}, status=422)
        try:
            with transaction.atomic():
                organization = AdministrativeOrganization.objects.create(
                    workspace=workspace, name=name, created_by=request.user
                )
                AdministrativeOrganizationMember.objects.create(
                    workspace=workspace,
                    organization=organization,
                    member=request.user,
                    role=AdministrativeOrganizationMember.Role.ADMIN,
                )
        except IntegrityError:
            return Response({"message": "An organization with this name already exists."}, status=409)
        return Response(_serialize_organization(organization, request.user), status=201)


class AdministrativeOrganizationDetailEndpoint(AdministrativeAPIView):
    """更新或删除非默认组织；删除前必须迁移其项目。"""

    nav_capability = None

    def patch(self, request, slug, organization_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = (
            AdministrativeOrganization.objects.filter(workspace=workspace, pk=organization_id, deleted_at__isnull=True)
            .select_related("workspace")
            .first()
        )
        if organization is None:
            return Response({"message": "Organization not found."}, status=404)
        if not user_can_manage_administrative_organization(request.user, slug, organization.id):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response({"message": "The default organization cannot be renamed."}, status=409)
        name = str(request.data.get("name") or "").strip()
        if "name" not in request.data or not name or len(name) > 255:
            return Response({"message": "Organization name is invalid."}, status=422)
        organization.name = name
        try:
            organization.save(update_fields=["name", "updated_at"])
        except IntegrityError:
            return Response({"message": "An organization with this name already exists."}, status=409)
        return Response(_serialize_organization(organization, request.user))

    def delete(self, request, slug, organization_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = AdministrativeOrganization.objects.filter(
            workspace=workspace, pk=organization_id, deleted_at__isnull=True
        ).first()
        if organization is None:
            return Response({"message": "Organization not found."}, status=404)
        if not user_can_manage_administrative_organization(request.user, slug, organization.id):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response({"message": "The default organization cannot be deleted."}, status=409)
        move_to = request.query_params.get("move_to")
        if not move_to:
            return Response({"message": "move_to is required."}, status=400)
        target_id, error = parse_uuid(move_to, "move_to")
        if error:
            return error
        target = AdministrativeOrganization.objects.filter(
            workspace=workspace, pk=target_id, deleted_at__isnull=True
        ).first()
        if target is None or target.id == organization.id:
            return Response({"message": "Select a different target organization."}, status=422)
        workspace_admin = _workspace_admin(request.user, workspace)
        target_authorized = target.is_default or user_can_administer_administrative_organization(
            request.user, slug, target.id
        )
        if not workspace_admin and not target_authorized:
            return Response({"message": "Not allowed."}, status=403)
        with transaction.atomic():
            Project.objects.filter(administrative_organization=organization).update(administrative_organization=target)
            organization.deleted_at = timezone.now()
            organization.save(update_fields=["deleted_at", "updated_at"])
        return Response(status=204)


class AdministrativeOrganizationMemberEndpoint(AdministrativeAPIView):
    """列出、添加、修改和移除组织成员。"""

    nav_capability = None

    def _organization(self, workspace, organization_id):
        return (
            AdministrativeOrganization.objects.filter(workspace=workspace, pk=organization_id, deleted_at__isnull=True)
            .select_related("workspace")
            .first()
        )

    def get(self, request, slug, organization_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = self._organization(workspace, organization_id)
        if organization is None:
            return Response({"message": "Organization not found."}, status=404)
        if not user_can_manage_administrative_organization(request.user, slug, organization.id):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response(
                {"message": "The public organization is available to every workspace member."},
                status=409,
            )
        return Response(_serialize_organization(organization, request.user)["members"])

    def post(self, request, slug, organization_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = self._organization(workspace, organization_id)
        if organization is None:
            return Response({"message": "Organization not found."}, status=404)
        if not user_can_manage_administrative_organization(request.user, slug, organization.id):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response(
                {"message": "The public organization is available to every workspace member."},
                status=409,
            )
        member_id, error = parse_uuid(request.data.get("member"), "member")
        if error:
            return error
        member = User.objects.filter(
            pk=member_id,
            member_workspace__workspace=workspace,
            member_workspace__is_active=True,
            member_workspace__deleted_at__isnull=True,
        ).first()
        if member is None:
            return Response({"message": "Member must be active in this workspace."}, status=422)
        role = request.data.get("role", AdministrativeOrganizationMember.Role.MEMBER)
        if role not in AdministrativeOrganizationMember.Role.values:
            return Response({"message": "Role is invalid."}, status=422)
        relation = (
            AdministrativeOrganizationMember.all_objects.filter(
                workspace=workspace,
                organization=organization,
                member=member,
            )
            .order_by("-updated_at")
            .first()
        )
        if relation is None:
            relation = AdministrativeOrganizationMember.objects.create(
                workspace=workspace,
                organization=organization,
                member=member,
                role=role,
                created_by=request.user,
            )
            created = True
        else:
            relation.role = role
            relation.is_active = True
            relation.deleted_at = None
            relation.save(update_fields=["role", "is_active", "deleted_at", "updated_at"])
            created = False
        return Response(
            {"id": str(relation.member_id), "role": relation.role},
            status=201 if created else 200,
        )

    def patch(self, request, slug, organization_id, member_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = self._organization(workspace, organization_id)
        if organization is None or not user_can_administer_administrative_organization(
            request.user, slug, organization.id
        ):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response(
                {"message": "The public organization is available to every workspace member."},
                status=409,
            )
        relation = AdministrativeOrganizationMember.objects.filter(
            workspace=workspace,
            organization=organization,
            member_id=member_id,
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        role = request.data.get("role")
        if relation is None:
            return Response({"message": "Member not found."}, status=404)
        if role not in AdministrativeOrganizationMember.Role.values:
            return Response({"message": "Role is invalid."}, status=422)
        relation.role = role
        relation.save(update_fields=["role", "updated_at"])
        return Response({"id": str(relation.member_id), "role": relation.role})

    def delete(self, request, slug, organization_id, member_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = self._organization(workspace, organization_id)
        if organization is None or not user_can_manage_administrative_organization(request.user, slug, organization.id):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response(
                {"message": "The public organization is available to every workspace member."},
                status=409,
            )
        relation = AdministrativeOrganizationMember.objects.filter(
            workspace=workspace,
            organization=organization,
            member_id=member_id,
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        if relation is None:
            return Response({"message": "Member not found."}, status=404)
        if relation.member_id == organization.created_by_id:
            return Response({"message": "The organization creator cannot be removed."}, status=409)
        relation.is_active = False
        relation.deleted_at = timezone.now()
        relation.save(update_fields=["is_active", "deleted_at", "updated_at"])
        return Response(status=204)


class AdministrativeOrganizationAssignableMembersEndpoint(AdministrativeAPIView):
    """返回可加入指定组织的工作区成员。"""

    nav_capability = None

    def get(self, request, slug, organization_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        organization = AdministrativeOrganization.objects.filter(
            workspace=workspace, pk=organization_id, deleted_at__isnull=True
        ).first()
        if organization is None:
            return Response({"message": "Organization not found."}, status=404)
        if not user_can_manage_administrative_organization(request.user, slug, organization.id):
            return Response({"message": "Not allowed."}, status=403)
        if organization.is_default:
            return Response(
                {"message": "The public organization is available to every workspace member."},
                status=409,
            )
        current_member_ids = organization.members.filter(is_active=True, deleted_at__isnull=True).values("member_id")
        members = (
            User.objects.filter(
                member_workspace__workspace=workspace,
                member_workspace__is_active=True,
                member_workspace__deleted_at__isnull=True,
                is_active=True,
            )
            .exclude(id__in=current_member_ids)
            .order_by("email")
        )
        return Response(
            [
                {"id": str(member.id), "name": member.display_name or member.email, "email": member.email}
                for member in members
            ]
        )


class AdministrativeProjectOrganizationEndpoint(AdministrativeAPIView):
    """更改行政项目的组织归属。"""

    nav_capability = None

    def post(self, request, slug, project_id):
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        project = (
            Project.objects.filter(
                workspace=workspace,
                pk=project_id,
                deleted_at__isnull=True,
                research_profile__isnull=True,
            )
            .exclude(id__in=ResearchChain.all_objects.values("project_id"))
            .first()
        )
        if project is None:
            return Response({"message": "Administrative project not found."}, status=404)
        raw_organization_id = request.data.get("organization")
        if raw_organization_id in (None, "", "default"):
            organization = get_or_create_default_administrative_organization(workspace)
            if organization is None:
                return Response({"message": "Default organization is unavailable."}, status=500)
        else:
            organization_id, error = parse_uuid(raw_organization_id, "organization")
            if error:
                return error
            organization = (
                AdministrativeOrganization.objects.filter(
                    workspace=workspace, pk=organization_id, deleted_at__isnull=True
                )
                .select_related("workspace")
                .first()
            )
        if raw_organization_id not in (None, "", "default") and organization is None:
            return Response({"message": "Organization not found."}, status=404)
        workspace_admin = _workspace_admin(request.user, workspace)
        current = project.administrative_organization
        source_authorized = bool(
            current and user_can_administer_administrative_organization(request.user, slug, current.id)
        )
        target_authorized = bool(
            organization is None
            or organization.is_default
            or user_can_administer_administrative_organization(request.user, slug, organization.id)
        )
        if not workspace_admin and not (source_authorized and target_authorized):
            return Response({"message": "Not allowed."}, status=403)
        project.administrative_organization = organization
        project.save(update_fields=["administrative_organization", "updated_at"])
        return Response({"project_id": str(project.id), "organization": str(organization.id) if organization else None})
