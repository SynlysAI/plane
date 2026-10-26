# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import os
from datetime import timedelta

# Django imports
from django.utils import timezone
from django.db.models import Q

# Third party imports
from celery import shared_task

# Module imports
from plane.db.models import FileAsset


@shared_task
def delete_unuploaded_file_asset():
    """This task deletes unuploaded file assets older than a certain number of days."""
    cutoff = timezone.now() - timedelta(days=int(os.environ.get("UNUPLOADED_ASSET_DELETE_DAYS", "7")))
    FileAsset.objects.filter(
        Q(created_at__lt=cutoff)
        & (Q(is_uploaded=False) | Q(entity_type=FileAsset.EntityTypeContext.COMMENT_ATTACHMENT, comment__isnull=True))
    ).delete()
    FileAsset.objects.filter(
        created_at__lt=cutoff,
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
        is_uploaded=False,
        research_task_comment_attachments__isnull=True,
    ).delete()
    FileAsset.objects.filter(
        created_at__lt=cutoff,
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_IMAGE,
    ).filter(Q(is_uploaded=False) | Q(is_deleted=True)).delete()
    FileAsset.objects.filter(
        created_at__lt=cutoff,
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_ATTACHMENT,
        is_uploaded=False,
        research_task_instruction_attachments__isnull=True,
    ).delete()
    FileAsset.objects.filter(
        created_at__lt=cutoff,
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_IMAGE,
    ).filter(Q(is_uploaded=False) | Q(is_deleted=True)).delete()
