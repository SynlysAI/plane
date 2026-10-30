"""项目与周报 MCP 共用的凭据存储和有效期规则。"""

import hmac
import hashlib
from datetime import timedelta

from django.db.models import Q
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from plane.license.utils.encryption import decrypt_data, encrypt_data

TTL_DAYS = (1, 7, 30, 365, None)
DEFAULT_TTL_DAYS = 365


class CredentialStorageError(ValueError):
    """凭据无法可靠加密或恢复。"""


def unexpired_connections():
    """生成仍在有效期内的连接查询条件。

    Returns:
        同时包含未到期和永不过期连接的 Q 条件。
    """
    return Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now())


def expires_after(days):
    """计算连接到期时间；None 表示永不过期。

    Args:
        days: 已校验的有效天数或 None。

    Returns:
        带时区的到期时间或 None。
    """
    return timezone.now() + timedelta(days=days) if days is not None else None


def valid_lifetime(days):
    """校验显式有效期，避免将布尔值当作天数。

    Args:
        days: 请求提供的有效天数或 None。

    Returns:
        是否属于支持的有效期选项。
    """
    return days is None or (type(days) is int and days in TTL_DAYS)


@sensitive_variables()
def seal_credential(raw):
    """加密并验证密钥，失败时拒绝持久化连接。

    Args:
        raw: 尚未持久化的访问密钥。

    Returns:
        已通过恢复核验的密文。
    """
    encrypted = encrypt_data(raw)
    if not encrypted or not hmac.compare_digest(decrypt_data(encrypted), raw):
        raise CredentialStorageError("credential_unavailable")
    return encrypted


@sensitive_variables()
def recover_credential(connection):
    """恢复并核验密钥；密文缺失或损坏时明确拒绝。

    Args:
        connection: 持有密文和鉴权摘要的连接记录。

    Returns:
        与当前鉴权摘要匹配的访问密钥。
    """
    raw = decrypt_data(connection.token_encrypted)
    if not raw or not hmac.compare_digest(hashlib.sha256(raw.encode()).hexdigest(), connection.token_hash):
        raise CredentialStorageError("credential_unavailable")
    return raw
