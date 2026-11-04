# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.apps import AppConfig


class BgtasksConfig(AppConfig):
    name = "plane.bgtasks"

    def ready(self):
        """Import Celery tasks that are not referenced by request-time modules."""
        from plane.bgtasks import agent_dock_task  # noqa: F401
