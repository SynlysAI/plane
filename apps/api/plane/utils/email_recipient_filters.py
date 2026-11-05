"""实例级邮件收件人过滤策略的校验、读取和匹配。"""

import json
import re
from copy import deepcopy
from email.utils import parseaddr
from uuid import UUID

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

EMAIL_RECIPIENT_FILTERS_KEY = "EMAIL_RECIPIENT_FILTERS"
DEFAULT_EMAIL_RECIPIENT_FILTERS = {
    "enabled": True,
    "rules": [
        {
            "id": "c1275450-bc1f-40b7-b18e-c71436cb0a2c",
            "type": "email",
            "value": "admin@ai4ms.local",
            "note": "管理员专用虚拟邮箱",
            "enabled": True,
        }
    ],
}


class EmailRecipientFilterValidationError(ValueError):
    """保存规则时可向管理员展示的校验错误。"""

    def __init__(self, detail):
        """保存结构化的字段或规则错误。

        Args:
            detail: 字段错误字典或规则错误列表。
        """
        super().__init__("invalid_email_recipient_filters")
        self.detail = detail


class EmailRecipientFilterConfigurationError(Exception):
    """策略不可用时阻止发送，由调用方执行既有失败处理。"""


def normalize_recipient_email(value):
    """规范化单个邮箱，支持显示名称并拒绝多个地址或邮件头。

    Args:
        value: 用户输入或邮件对象中的单个收件地址。

    Returns:
        不区分大小写且域名经 IDNA 规范化的邮箱。
    """
    if not isinstance(value, str) or not value.strip() or any(c in value for c in "\r\n"):
        raise ValueError("请输入有效的邮箱地址。")
    _, address = parseaddr(value.strip())
    try:
        validate_email(address)
        local, domain = address.rsplit("@", 1)
        return f"{local.casefold()}@{domain.encode('idna').decode('ascii').casefold()}"
    except (ValidationError, ValueError, UnicodeError) as exc:
        raise ValueError("请输入有效的邮箱地址。") from exc


def normalize_filter_target(rule_type, value):
    """校验并规范化邮箱或精确域名规则。

    Args:
        rule_type: email 或 domain。
        value: 原始规则目标，域名允许一个前导 @。

    Returns:
        用于保存和比较的规范化目标。
    """
    if not isinstance(value, str) or len(value) > 320:
        raise ValueError("目标地址过长或格式无效。")
    if rule_type == "email":
        return normalize_recipient_email(value)
    if rule_type != "domain":
        raise ValueError("规则类型必须为邮箱或域名。")
    domain = value.strip().removeprefix("@").casefold()
    try:
        domain = domain.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError("请输入有效的域名。") from exc
    labels = domain.split(".")
    if len(domain) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
        raise ValueError("请输入精确域名，不支持通配符、路径或正则表达式。")
    return domain


def validate_email_recipient_filters(data):
    """校验完整策略，保留稳定 ID，并拒绝重复目标。

    Args:
        data: 包含 enabled 和 rules 的策略字典。

    Returns:
        可直接持久化的规范化策略；失败时抛出结构化校验错误。
    """
    if not isinstance(data, dict) or set(data) != {"enabled", "rules"}:
        raise EmailRecipientFilterValidationError({"policy": "策略必须包含 enabled 和 rules。"})
    if type(data["enabled"]) is not bool or not isinstance(data["rules"], list):
        raise EmailRecipientFilterValidationError({"policy": "开关必须为布尔值，规则必须为列表。"})
    if len(data["rules"]) > 1000:
        raise EmailRecipientFilterValidationError({"rules": "最多保存 1000 条规则。"})
    rules, errors, ids, targets = [], [], set(), set()
    for index, rule in enumerate(data["rules"]):
        try:
            if not isinstance(rule, dict) or set(rule) != {"id", "type", "value", "note", "enabled"}:
                raise ValueError("规则字段不完整。")
            try:
                rule_id = str(UUID(rule["id"]))
            except (ValueError, TypeError, AttributeError) as exc:
                raise ValueError("规则 ID 必须为有效的 UUID。") from exc
            if rule_id in ids:
                raise ValueError("规则 ID 重复。")
            if type(rule["enabled"]) is not bool:
                raise ValueError("启用状态必须为布尔值。")
            if not isinstance(rule["note"], str) or len(rule["note"]) > 500:
                raise ValueError("备注最多 500 个字符。")
            value = normalize_filter_target(rule["type"], rule["value"])
            target = (rule["type"], value)
            if target in targets:
                raise ValueError("与已有规则重复。")
            ids.add(rule_id)
            targets.add(target)
            rules.append({**rule, "id": rule_id, "value": value, "note": rule["note"].strip()})
        except (ValueError, TypeError, AttributeError) as exc:
            errors.append({"index": index, "message": str(exc)})
    if errors:
        raise EmailRecipientFilterValidationError({"rules": errors})
    return {"enabled": data["enabled"], "rules": rules}


def get_email_recipient_filters():
    """每次检查读取数据库策略；缺失时默认屏蔽管理员虚拟邮箱。

    Returns:
        已校验策略；数据库、JSON 或结构异常时抛出配置错误。
    """
    from plane.license.models import InstanceConfiguration

    try:
        row = InstanceConfiguration.objects.filter(key=EMAIL_RECIPIENT_FILTERS_KEY).values("value").first()
        if row is None:
            return deepcopy(DEFAULT_EMAIL_RECIPIENT_FILTERS)
        return validate_email_recipient_filters(json.loads(row["value"]))
    except Exception as exc:
        raise EmailRecipientFilterConfigurationError("email_recipient_filters_unavailable") from exc


def match_email_recipient_filter(email_address, policy):
    """用一次读取的策略匹配邮箱或其精确域名。

    Args:
        email_address: 单个收件邮箱，可包含显示名称。
        policy: 已校验的策略，批次内由调用方复用。

    Returns:
        首个启用的命中规则，未命中或总开关关闭时返回 None。
    """
    if not policy["enabled"]:
        return None
    try:
        address = normalize_recipient_email(email_address)
    except ValueError:
        return None
    domain = address.rsplit("@", 1)[1]
    return next(
        (
            rule
            for rule in policy["rules"]
            if rule["enabled"] and rule["value"] == (address if rule["type"] == "email" else domain)
        ),
        None,
    )
