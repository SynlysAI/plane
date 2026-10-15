# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.views import View
from django.contrib.auth import logout
from django.http import HttpResponseRedirect
from django.utils import timezone

# Module imports
from plane.authentication.utils.host import user_ip, base_host
from plane.db.models import User
from plane.utils.path_validator import validate_next_path


class SignOutAuthEndpoint(View):
    def post(self, request):
        next_path = validate_next_path(request.POST.get("next_path"))
        redirect_url = f"{base_host(request=request, is_app=True).rstrip('/')}{next_path}"
        # Get user
        try:
            user = User.objects.get(pk=request.user.id)
            user.last_logout_ip = user_ip(request=request)
            user.last_logout_time = timezone.now()
            user.save()
            # Log the user out
            logout(request)
            return HttpResponseRedirect(redirect_url)
        except Exception:
            return HttpResponseRedirect(redirect_url)
