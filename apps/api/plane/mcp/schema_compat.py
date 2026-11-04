"""面向客户端的 JSON Schema 投影，不放宽服务端校验。"""

from copy import deepcopy

BRANCH_HINT = "Choose one supported branch and provide every field required by that branch."
NULL_HINT = "A null value is allowed."


def _merge_required(branches):
    """合并联合分支的必填字段，仅保留所有分支共同要求的部分。

    Args:
        branches: 已完成投影的 JSON Schema 分支列表。

    Returns:
        可安全作为普通 required 输出的字段名列表。
    """
    if not branches:
        return []
    return [
        item
        for item in branches[0].get("required", [])
        if all(item in branch.get("required", []) for branch in branches[1:])
    ]


def _merge_properties(branches):
    """递归合并联合分支的属性定义。

    Args:
        branches: 已完成投影的 JSON Schema 分支列表。

    Returns:
        合并后的属性字典。
    """
    properties = {}
    keys = [key for branch in branches for key in branch.get("properties", {})]
    for key in dict.fromkeys(keys):
        variants = [branch["properties"][key] for branch in branches if key in branch.get("properties", {})]
        properties[key] = _merge_schemas(variants)
    return properties


def _common_metadata(schema, key, branches):
    """仅保留所有联合分支一致的元数据约束。

    Args:
        schema: 正在合并的 Schema 字典。
        key: 元数据字段名。
        branches: 已完成投影的 JSON Schema 分支列表。

    Returns:
        无返回值；冲突元数据会被省略，避免投影后错误拒绝另一个合法分支。
    """
    if all(key in branch for branch in branches):
        values = [branch[key] for branch in branches]
        if all(value == values[0] for value in values[1:]):
            schema[key] = values[0]


def _merge_bounds(schema, branches):
    """合并数值与字符串边界，保留最宽松的客户端输入范围。

    Args:
        schema: 正在合并的 Schema 字典。
        branches: 已完成投影的 JSON Schema 分支列表。
    """
    for key in ("minimum", "minLength", "minItems"):
        if all(key in branch for branch in branches):
            schema[key] = min(branch[key] for branch in branches)
    for key in ("maximum", "maxLength", "maxItems"):
        if all(key in branch for branch in branches):
            schema[key] = max(branch[key] for branch in branches)


def _merge_schemas(branches):
    """把多个互斥分支合并为客户端友好的普通 JSON Schema。

    Args:
        branches: 已完成投影的 JSON Schema 分支列表。

    Returns:
        不含 anyOf、oneOf、const 或数组 type 的合并 Schema。
    """
    if len(branches) == 1:
        return deepcopy(branches[0])
    schema = {}
    kinds = [branch.get("type") for branch in branches if "type" in branch]
    if "object" in kinds:
        schema["type"] = "object"
    elif kinds and len(kinds) == len(branches) and len(set(kinds)) == 1:
        schema["type"] = kinds[0]
    if any("properties" in branch for branch in branches):
        schema["properties"] = _merge_properties(branches)
    if schema.get("type") == "object":
        required = _merge_required(branches)
        if required:
            schema["required"] = required
        branch_required = [set(branch.get("required", [])) for branch in branches]
        alternatives = set().union(*branch_required) - set.intersection(*branch_required)
        needs_hint = bool(alternatives)
    else:
        needs_hint = False
    values = [value for branch in branches for value in branch.get("enum", [])]
    if values:
        schema["enum"] = list(dict.fromkeys(values))
    if any("items" in branch for branch in branches):
        items = [branch["items"] for branch in branches if "items" in branch]
        schema["items"] = _merge_schemas(items)
    if schema.get("type") == "object":
        schema["additionalProperties"] = all(branch.get("additionalProperties") is True for branch in branches)
    _merge_bounds(schema, branches)
    for key in (
        "format",
        "pattern",
        "default",
        "uniqueItems",
        "minProperties",
        "maxProperties",
        "multipleOf",
        "exclusiveMinimum",
        "exclusiveMaximum",
    ):
        _common_metadata(schema, key, branches)
    descriptions = list(dict.fromkeys(branch["description"] for branch in branches if branch.get("description")))
    if descriptions:
        schema["description"] = " ".join(descriptions)
    if needs_hint:
        schema["description"] = " ".join(part for part in (schema.get("description"), BRANCH_HINT) if part)
    return schema


def project_schema(schema):
    """把内部严格 Schema 投影为标准客户端易解析的 Schema 子集。

    Args:
        schema: 服务端内部使用的 JSON Schema。

    Returns:
        移除联合结构、const 和数组 type 后的 Schema 副本。
    """
    branches = schema.get("anyOf", schema.get("oneOf"))
    if branches is not None:
        return _merge_schemas([project_schema(branch) for branch in branches])

    result = deepcopy(schema)
    if "const" in result:
        result["enum"] = [result.pop("const")]
    if isinstance(result.get("type"), list):
        kinds = result.pop("type")
        non_null = [kind for kind in kinds if kind != "null"]
        if not non_null:
            result["type"] = "null"
        if "null" in kinds and non_null:
            # JSON Schema 数组类型会被部分客户端解析失败；省略 type 并用
            # 标准 description 提示 null，可避免客户端错误拒绝合法空值。
            result["description"] = " ".join(part for part in (result.get("description"), NULL_HINT) if part)
    if "properties" in result:
        result["properties"] = {key: project_schema(value) for key, value in result["properties"].items()}
    if "items" in result:
        result["items"] = project_schema(result["items"])
    return result


def project_tools(tools):
    """批量投影 MCP 工具定义，仅调整客户端可见 inputSchema。

    Args:
        tools: 内部工具定义列表。

    Returns:
        保留名称、描述和 annotations 的工具列表副本。
    """
    return [{**deepcopy(tool), "inputSchema": project_schema(tool["inputSchema"])} for tool in tools]
