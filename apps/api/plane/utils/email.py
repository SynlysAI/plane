# SPDX-FileCopyrightText: 2023-present Plane Software, Inc.
# SPDX-License-Identifier: LicenseRef-Plane-Commercial
#
# Licensed under the Plane Commercial License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# https://plane.so/legals/eula
#
# DO NOT remove or modify this notice.
# NOTICE: Proprietary and confidential. Unauthorized use or distribution is prohibited.

# Python imports
import re

# Django imports
from django.core.mail import EmailMessage
from django.utils.html import strip_tags


from plane.utils.email_recipient_filters import get_email_recipient_filters, match_email_recipient_filter


def is_email_recipient_blocked(email_address: str, policy=None) -> bool:
    """判断收件地址是否命中当前实例的邮件过滤策略。

    Args:
        email_address: 原始邮箱地址，可包含显示名称和首尾空格。
        policy: 可选的已读取策略，用于同一邮件或批次内复用。

    Returns:
        规范化后的邮箱地址或其精确域名是否命中启用的规则。
    """
    if policy is None:
        policy = get_email_recipient_filters()
    return match_email_recipient_filter(email_address, policy) is not None


def filter_email_recipients(message: EmailMessage, policy=None) -> int:
    """从邮件的收件、抄送和密送列表中移除被屏蔽的地址。

    Args:
        message: 待发送的 Django 邮件对象，收件人列表会就地更新。
        policy: 可选的已读取策略。

    Returns:
        本次移除的收件地址数量。
    """
    # https://docs.djangoproject.com/en/5.2/topics/email/#emailmessage-objects
    if policy is None:
        policy = get_email_recipient_filters()
    removed_count = 0
    for field in ("to", "cc", "bcc"):
        recipients = getattr(message, field)
        allowed = [address for address in recipients if not is_email_recipient_blocked(address, policy)]
        removed = len(recipients) - len(allowed)
        if removed:
            setattr(message, field, allowed)
            removed_count += removed
    return removed_count


def generate_plain_text_from_html(html_content):
    """
    Generate clean plain text from HTML email template.
    Removes all HTML tags, CSS styles, and excessive whitespace.

    Args:
        html_content (str): The HTML content to convert to plain text

    Returns:
        str: Clean plain text without HTML tags, styles, or excessive whitespace
    """
    # Remove style tags and their content
    html_content = re.sub(r"<style[^>]*>.*?</style>", "", html_content, flags=re.DOTALL | re.IGNORECASE)

    # Strip HTML tags
    text_content = strip_tags(html_content)

    # Remove excessive empty lines
    text_content = re.sub(r"\n\s*\n\s*\n+", "\n\n", text_content)

    # Ensure there's a leading and trailing whitespace
    text_content = "\n\n" + text_content.lstrip().rstrip() + "\n\n"

    return text_content
