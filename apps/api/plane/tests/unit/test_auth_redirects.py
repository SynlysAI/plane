# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import pytest
from django.test import RequestFactory, override_settings

from plane.authentication.views.app.signout import SignOutAuthEndpoint
from plane.utils.path_validator import get_safe_redirect_url


@pytest.mark.unit
@override_settings(
    WEB_URL="https://plane.example.com",
    APP_BASE_URL="https://plane.example.com",
    ADMIN_BASE_URL="",
    SPACE_BASE_URL="",
)
def test_auth_redirect_preserves_nested_invitation_query():
    invitation_path = "/workspace-invitations/?invitation_id=invite-1&slug=lab&token=signed%2Btoken%3D"
    url = get_safe_redirect_url(
        "https://plane.example.com", invitation_path, {"email": "invite@example.com", "error_code": "test"}
    )
    params = parse_qs(urlsplit(url).query)
    assert params["next_path"] == [invitation_path]
    assert params["email"] == ["invite@example.com"]
    assert params["error_code"] == ["test"]
    assert "token" not in params


@pytest.mark.unit
@pytest.mark.parametrize(
    ("next_path", "expected_path"),
    [
        (
            "/workspace-invitations/?invitation_id=invite-1&slug=lab&token=signed",
            "/workspace-invitations/?invitation_id=invite-1&slug=lab&token=signed",
        ),
        ("", ""),
        ("//evil.example.com/", "/"),
        ("javascript:alert(1)", ""),
    ],
)
def test_signout_returns_to_a_local_invitation(next_path, expected_path):
    request = RequestFactory().post("/auth/sign-out/", {"next_path": next_path})
    with (
        patch("plane.authentication.views.app.signout.base_host", return_value="https://plane.example.com"),
        patch("plane.authentication.views.app.signout.User") as user_model,
        patch("plane.authentication.views.app.signout.logout") as logout,
    ):
        request.user = user_model.objects.get.return_value
        response = SignOutAuthEndpoint().post(request)
    assert response.status_code == 302
    assert response.url == f"https://plane.example.com{expected_path}"
    logout.assert_called_once_with(request)
