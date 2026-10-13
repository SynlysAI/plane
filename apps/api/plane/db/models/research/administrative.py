"""独立于科研组织的行政项目组织和组织成员。"""

from django.conf import settings
from django.db import IntegrityError, models
from django.db.models import Q
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver
from django.utils import timezone

from plane.db.models.base import BaseModel
from plane.db.models.workspace import Workspace, WorkspaceMember


class AdministrativeOrganization(BaseModel):
    """工作区内行政项目的平级组织。"""

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="administrative_organizations")
    name = models.CharField(max_length=255)
    is_default = models.BooleanField(default=False)

    class Meta:
        db_table = "administrative_organizations"
        ordering = ("name", "created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "name"],
                condition=Q(deleted_at__isnull=True),
                name="admin_org_workspace_name_uq",
            ),
            models.UniqueConstraint(
                fields=["workspace"],
                condition=Q(is_default=True, deleted_at__isnull=True),
                name="admin_org_workspace_default_uq",
            ),
        ]


class AdministrativeOrganizationMember(BaseModel):
    """组织成员及其组织管理角色。"""

    class Role(models.TextChoices):
        ADMIN = "ADMIN", "Administrator"
        MEMBER = "MEMBER", "Member"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE)
    organization = models.ForeignKey(AdministrativeOrganization, on_delete=models.CASCADE, related_name="members")
    member = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    role = models.CharField(max_length=12, choices=Role.choices, default=Role.MEMBER)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "administrative_organization_members"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "member"],
                condition=Q(deleted_at__isnull=True),
                name="admin_org_member_uq",
            )
        ]
        indexes = [models.Index(fields=["member", "is_active"], name="admin_org_member_user_idx")]


@receiver(post_save, sender=Workspace)
def create_default_administrative_organization(sender, instance, created, **kwargs):
    """为迁移后新建的工作区幂等创建唯一默认行政组织。"""
    if not created:
        return
    try:
        AdministrativeOrganization.objects.get_or_create(
            workspace=instance,
            is_default=True,
            defaults={"name": "默认", "created_by": instance.owner},
        )
    except IntegrityError:
        # 并发创建时以数据库唯一约束中的已有默认组织为准。
        pass


@receiver([post_save, post_delete], sender=WorkspaceMember)
def deactivate_administrative_organization_memberships(sender, instance, **kwargs):
    """工作区成员移除时停用行政组织继承权限。

    重新加入工作区不会自动恢复组织身份，需要组织管理员重新添加。
    """
    if kwargs.get("created"):
        return
    if kwargs.get("signal") is post_save and instance.is_active and instance.deleted_at is None:
        return
    AdministrativeOrganizationMember.objects.filter(
        workspace_id=instance.workspace_id,
        member_id=instance.member_id,
        is_active=True,
        deleted_at__isnull=True,
    ).update(is_active=False, deleted_at=timezone.now(), updated_at=timezone.now())
