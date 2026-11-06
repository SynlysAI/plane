"""各类 MCP 闭合契约共享的原始字段与对象引用。"""


def text(maximum=200):
    """生成有长度边界的文本字段。"""
    return {"type": "string", "minLength": 1, "maxLength": maximum}


UUID = {"type": "string", "format": "uuid"}


def obj(properties, required=()):
    """生成拒绝未知字段的对象契约。"""
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def union(*branches):
    """合并客户端可发现的字段，同时保留逐分支严格验证。"""
    properties = {}
    for branch in branches:
        for key, value in branch["properties"].items():
            if key not in properties:
                properties[key] = value
            elif properties[key] != value:
                variants = properties[key].get("anyOf", [properties[key]])
                if value not in variants:
                    properties[key] = {"anyOf": [*variants, value]}
    return {**obj(properties), "anyOf": list(branches)}


def enum(*values):
    """生成有限字符串枚举。"""
    return {"type": "string", "enum": list(values)}


def ref(domain, *types):
    """生成显式业务域、工作区及原生对象类型的引用。"""
    fields = {"domain": {"const": domain}, "workspace_slug": text(80), "object_type": enum(*types)}
    return union(
        obj({**fields, "id": UUID}, [*fields, "id"]),
        obj({**fields, "url": {**text(2048), "format": "uri"}}, [*fields, "url"]),
    )


PAGING = {"cursor": text(4096), "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}}
TARGET = union(
    ref("administrative", "Project", "Issue"),
    ref("research", "ResearchChain", "ResearchChainNode", "ResearchChainNodeTask"),
)
REQUEST_ID = {**text(128), "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"}
