"""Closed v2.1 schemas shared by the backend operation transports."""

from copy import deepcopy

from uuid import UUID as UUIDValue

from plane.research.services.mcp_catalog import ResearchReadError, RESOURCE_KINDS


def text(maximum=8000):
    return {"type": "string", "minLength": 1, "maxLength": maximum}


UUID = {"type": "string", "format": "uuid"}


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


# OUTCOME is deliberately not accepted until it has a node-scoped read resolver.
RESOURCE_TYPES = {"REPORT": "report", "STAGE_MATERIAL": "stage_material", "PAPER_REVIEW": "paper_review",
                  "SNAPSHOT": "snapshot", "EXTERNAL_REF": "external_reference"}
PAYLOADS = {
    "create_task": obj({"title": text(500), "instruction": text()}, ["title"]),
    "append_task_comment": obj({"task_id": UUID, "text": text()}, ["task_id", "text"]),
    "save_analysis_draft": obj({"method": text(255), "summary": text(), "conclusion": text()}, ["method", "summary"]),
    "attach_task_resource": obj({"task_id": UUID, "resource_type": {"enum": list(RESOURCE_TYPES)},
                                 "resource_id": UUID, "version": {"type": "integer", "minimum": 1}},
                                ["task_id", "resource_type", "resource_id"]),
    "append_research_note": obj({"text": text()}, ["text"]),
}
ACTIONS = frozenset(PAYLOADS)
SOURCE = obj({"kind": {"enum": list(RESOURCE_KINDS)}, "id": UUID,
              "version": {"type": "integer", "minimum": 1},
              "usage": {"enum": ["metadata", "body"]}}, ["kind", "id", "usage"])


def tool(name, description, schema, readonly=False):
    return {"name": name, "description": description, "inputSchema": schema,
            "annotations": {"readOnlyHint": readonly, "destructiveHint": False,
                            "idempotentHint": True, "openWorldHint": False}}


OPERATION_TOOLS = (
    tool("prepare_research_operation",
         "Prepare an immutable node-scoped proposal for review in the Agent client. "
         "No target business objects are changed. Plane does not require a separate approval.",
         {"oneOf": [obj({"request_id": text(128), "node_id": UUID, "action": {"const": action},
                          "payload": payload, "source_refs": {"type": "array", "items": SOURCE, "maxItems": 8}},
                         ["request_id", "node_id", "action", "payload"]) for action, payload in PAYLOADS.items()]}),
    tool("get_research_operation", "Read an operation and recover its durable commit/readback result.", obj({"operation_id": UUID}, ["operation_id"]), True),
    tool("list_research_operations", "List your proposals in the authorised node. Follow the returned cursor.",
         obj({"node_id": UUID, "cursor": text(4096), "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, ["node_id"]), True),
    tool("execute_research_operation",
         "Submit the prepared proposal once after user authorization in the Agent client. "
         "No separate Plane approval is required. Cannot replace its payload. "
         "After timeout query the same operation_id.", obj({"operation_id": UUID}, ["operation_id"])),
    tool("cancel_research_operation", "Cancel an unexecuted proposal. Committed business data cannot be undone with this tool.", obj({"operation_id": UUID}, ["operation_id"])),
)
OPERATION_TOOL_NAMES = frozenset(tool["name"] for tool in OPERATION_TOOLS)


def validate_operation(name, arguments):
    schema = next((tool["inputSchema"] for tool in OPERATION_TOOLS if tool["name"] == name), None)
    if schema is None or not matches(schema, arguments):
        raise ResearchReadError("invalid_arguments", "Unknown operation, missing fields or invalid action payload.")
    result = deepcopy(arguments)
    for key in ("operation_id", "node_id"):
        if key in result:
            result[key] = str(UUIDValue(result[key]))
    for key in ("task_id", "resource_id"):
        if key in result.get("payload", {}):
            result["payload"][key] = str(UUIDValue(result["payload"][key]))
    for ref in result.get("source_refs", []):
        ref["id"] = str(UUIDValue(ref["id"]))
    refs = result.get("source_refs", [])
    if len({(ref["kind"], ref["id"], ref.get("version"), ref["usage"]) for ref in refs}) != len(refs):
        raise ResearchReadError("invalid_arguments", "Duplicate source references are not permitted.")
    if result.get("action") == "create_task":
        result["payload"]["title"] = result["payload"]["title"].strip()
    return result


def matches(schema, value):
    """Validate only the closed dialect above, without a new backend dependency."""
    if "oneOf" in schema:
        return sum(matches(part, value) for part in schema["oneOf"]) == 1
    if "const" in schema:
        return type(value) is type(schema["const"]) and value == schema["const"]
    if "enum" in schema:
        return isinstance(value, str) and value in schema["enum"]
    kind = schema["type"]
    if kind == "object":
        return (isinstance(value, dict) and not (set(value) - schema["properties"].keys())
                and not (set(schema["required"]) - value.keys())
                and all(matches(schema["properties"][key], item) for key, item in value.items()))
    if kind == "array":
        return isinstance(value, list) and len(value) <= schema["maxItems"] and all(matches(schema["items"], item) for item in value)
    if kind == "integer":
        return type(value) is int and schema.get("minimum", 0) <= value <= schema.get("maximum", 2147483647)
    if kind == "string":
        if not isinstance(value, str) or not schema.get("minLength", 1) <= len(value) <= schema.get("maxLength", 200) or not value.strip():
            return False
        if schema.get("format") == "uuid":
            try:
                return str(UUIDValue(value)) == value.lower()
            except ValueError:
                return False
        return True
    return False
