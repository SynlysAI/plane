import pytest
from rest_framework import status

from plane.db.models import FileAsset, Profile


@pytest.mark.contract
class TestUserBackgroundAssets:
    @pytest.mark.django_db
    def test_user_background_asset_uses_static_url(self, session_client, create_user):
        """用户背景必须是独立个人资产，不能误绑定个人资料封面。"""
        response = session_client.post(
            "/api/assets/v2/user-assets/",
            {
                "name": "wallpaper.png",
                "type": "image/png",
                "size": 1024,
                "entity_type": FileAsset.EntityTypeContext.USER_BACKGROUND,
            },
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        asset = FileAsset.objects.get(id=response.data["asset_id"])
        assert asset.entity_type == FileAsset.EntityTypeContext.USER_BACKGROUND
        assert asset.user == create_user
        assert response.data["asset_url"] == f"/api/assets/v2/static/{asset.id}/"
        assert create_user.cover_image_asset_id is None

        confirm_response = session_client.patch(f"/api/assets/v2/user-assets/{asset.id}/", format="json")
        assert confirm_response.status_code == status.HTTP_204_NO_CONTENT
        asset.refresh_from_db()
        assert asset.is_uploaded is True
        assert create_user.cover_image_asset_id is None

        static_response = session_client.get(response.data["asset_url"])
        assert static_response.status_code == status.HTTP_302_FOUND

    @pytest.mark.django_db
    def test_profile_can_persist_background_preference(self, session_client, create_user):
        """背景来源持久化在现有 profile.theme JSON 中。"""
        profile = Profile.objects.create(user=create_user, theme={})
        response = session_client.patch(
            "/api/users/me/profile/",
            {"theme": {**profile.theme, "backgroundImage": "/api/assets/v2/static/background/"}},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        profile.refresh_from_db()
        assert profile.theme["backgroundImage"] == "/api/assets/v2/static/background/"
