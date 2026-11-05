"""系统专用邮箱的收件人过滤测试。"""

import pytest
from django.core.mail import EmailMultiAlternatives

from plane.utils.email import filter_email_recipients, is_email_recipient_blocked

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    "address",
    [
        "admin@ai4ms.local",
        "ADMIN@AI4MS.LOCAL",
        "  admin@ai4ms.local  ",
        "System Admin <admin@ai4ms.local>",
        "管理员 <ADMIN@AI4MS.LOCAL>",
    ],
)
def test_system_admin_email_is_blocked(address):
    """屏蔽规范化后匹配管理员邮箱的地址。

    Args:
        address: 管理员邮箱的不同表示形式。
    """
    assert is_email_recipient_blocked(address) is True


@pytest.mark.parametrize(
    "address",
    [
        "member@example.com",
        "admin@example.com",
        "dev.admin@ai4ms.local",
        "ops.admin@ai4ms.local",
        "admin@sub.ai4ms.local",
        "admin@ai4ms.local.example.com",
        "admin+test@ai4ms.local",
        "admin@ai4ms.local <member@example.com>",
        "",
    ],
)
def test_other_email_addresses_are_allowed(address):
    """精确匹配收件邮箱，不根据显示名称、角色或域名扩大屏蔽范围。

    Args:
        address: 应继续允许发送的邮箱地址。
    """
    assert is_email_recipient_blocked(address) is False


def test_filter_preserves_allowed_recipients_in_each_header():
    """混合收件人过滤保留各列表内正常地址的顺序和显示名称。"""
    message = EmailMultiAlternatives(
        to=["admin@ai4ms.local", "Member <member@example.com>"],
        cc=["ops.admin@ai4ms.local", "Admin <ADMIN@AI4MS.LOCAL>"],
        bcc=[" admin@ai4ms.local ", "other@example.com"],
    )

    assert filter_email_recipients(message) == 3
    assert message.to == ["Member <member@example.com>"]
    assert message.cc == ["ops.admin@ai4ms.local"]
    assert message.bcc == ["other@example.com"]
    assert filter_email_recipients(message) == 0


def test_filter_removes_all_blocked_recipients():
    """所有收件人被屏蔽时，邮件不再包含任何投递地址。"""
    message = EmailMultiAlternatives(
        to=["admin@ai4ms.local"],
        cc=["ADMIN@AI4MS.LOCAL"],
        bcc=["Admin <admin@ai4ms.local>"],
    )

    assert filter_email_recipients(message) == 3
    assert message.recipients() == []
