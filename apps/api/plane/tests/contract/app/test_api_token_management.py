# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""API token metadata and owner boundaries; all credentials are synthetic."""

import pytest
from rest_framework.test import APIClient
from plane.db.models import APIToken
from plane.tests.research_fixtures import make_user

pytestmark = pytest.mark.contract


def test_api_tokens_metadata_owner_boundary_and_no_secret_on_update(db):
    owner, other = make_user(), make_user()
    token = APIToken.objects.create(user=owner, label="Synthetic")
    foreign = APIToken.objects.create(user=other)
    service = APIToken.objects.create(user=owner, is_service=True)
    api = APIClient()
    api.force_authenticate(owner)
    path = "/api/users/api-tokens/"
    listing = api.get(path)
    assert listing.status_code == 200
    assert [row["id"] for row in listing.json()] == [str(token.pk)]
    assert token.token not in str(listing.data)
    assert listing.json()[0]["masked_token"] == f"{token.token[:14]}********{token.token[-4:]}"
    assert api.get(path + str(token.pk) + "/").status_code == 200
    for hidden in (foreign, service):
        assert api.get(path + str(hidden.pk) + "/").status_code == 404
        assert api.delete(path + str(hidden.pk) + "/").status_code == 404
        assert api.patch(path + str(hidden.pk) + "/", {"label": "Forbidden rename"}, format="json").status_code == 404
    response = api.patch(
        path + str(token.pk) + "/", {"label": "Updated", "user": str(other.pk), "is_service": True}, format="json"
    )
    assert response.status_code == 200
    assert "token" not in response.json()
    assert response.json()["masked_token"] == listing.json()[0]["masked_token"]
    token.refresh_from_db()
    assert token.user_id == owner.pk and not token.is_service
    assert api.delete(path + str(token.pk) + "/").status_code == 204
    assert api.delete(path + str(token.pk) + "/").status_code == 404
    assert APIToken.objects.filter(pk=foreign.pk).exists()


def test_creation_is_only_secret_response_and_inactive_is_honoured(db):
    api = APIClient()
    api.force_authenticate(make_user())
    path = "/api/users/api-tokens/"
    response = api.post(path, {"label": "One-time key"}, format="json")
    assert response.status_code == 201
    assert response.json()["token"]
    token = APIToken.objects.get(pk=response.json()["id"])
    token.is_active = False
    token.save(update_fields=["is_active"])
    response = api.get(path + str(token.pk) + "/")
    assert "token" not in response.json()
    assert response.json()["is_active"] is False
    assert response["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_creation_rejects_invalid_metadata_before_storing_a_credential(db):
    api = APIClient()
    api.force_authenticate(make_user())

    invalid_payloads = (
        {"label": ""},
        {"label": "x" * 256},
        {"expired_at": "not-a-date"},
    )
    for payload in invalid_payloads:
        assert api.post("/api/users/api-tokens/", payload, format="json").status_code == 400
    assert APIToken.objects.count() == 0


def test_rename_validates_name_and_preserves_the_credential(db):
    owner = make_user()
    token = APIToken.objects.create(user=owner, label="Original")
    original_key = token.token
    api = APIClient()
    api.force_authenticate(owner)
    path = f"/api/users/api-tokens/{token.pk}/"
    for label in ("", "   ", "x" * 256):
        assert api.patch(path, {"label": label}, format="json").status_code == 400
    response = api.patch(path, {"label": "  New name  "}, format="json")
    assert response.status_code == 200
    assert response.json()["label"] == "New name"
    assert "token" not in response.json()
    token.refresh_from_db()
    assert token.token == original_key
    assert token.label == "New name"
    assert (
        api.patch(
            "/api/users/api-tokens/00000000-0000-0000-0000-000000000000/", {"label": "Missing"}, format="json"
        ).status_code
        == 404
    )


def test_short_custom_tokens_never_reveal_the_complete_credential(db):
    owner = make_user()
    token = APIToken.objects.create(user=owner, label="Short synthetic token", token="short-key")
    api = APIClient()
    api.force_authenticate(owner)
    response = api.get(f"/api/users/api-tokens/{token.pk}/")
    assert response.status_code == 200
    assert response.json()["masked_token"] == "********"
    assert token.token not in str(response.json())
