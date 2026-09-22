"""Contract fixture checks for the Phase 0 cross-repository schemas."""

import json
from pathlib import Path

import pytest


def _contract_root():
    """Locate the repository contract directory in host and container runs."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "docs" / "contracts" / "research-intelligent-platform"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("research-intelligent-platform contract directory not found")


CONTRACT_ROOT = _contract_root()
SCHEMA_ROOT = CONTRACT_ROOT / "schemas"
EXAMPLE_ROOT = CONTRACT_ROOT / "examples"


def _load(path):
    """Load one JSON contract resource."""
    return json.loads(path.read_text(encoding="utf-8"))


def _validate_minimal_schema(schema, example):
    """Validate the JSON Schema subset used by the checked-in fixtures.

    The API test image intentionally has no runtime JSON-Schema dependency. The
    check still enforces the contract's required fields, constants and enums;
    a full JSON-Schema validator can be layered on in CI without changing the
    fixture format.
    """
    assert schema["type"] == "object"
    assert isinstance(example, dict)
    for field in schema.get("required", []):
        assert field in example, f"missing required field: {field}"
    for field, definition in schema.get("properties", {}).items():
        if field not in example:
            continue
        if "const" in definition:
            assert example[field] == definition["const"]
        if "enum" in definition:
            assert example[field] in definition["enum"]


@pytest.mark.parametrize(
    "name",
    [
        "research-chain",
        "research-node",
        "research-event",
        "research-snapshot",
        "agent-context",
        "agent-trace",
        "account-link",
        "integration-result",
        "job-status",
    ],
)
def test_all_v1_schema_examples_are_valid(name):
    """Every Phase 0 schema has a valid example accepted by its schema."""
    schema = _load(SCHEMA_ROOT / f"{name}.v1.json")
    example = _load(EXAMPLE_ROOT / f"{name}.v1.json")
    _validate_minimal_schema(schema, example)


def test_unknown_fields_are_forward_compatible():
    """Consumers may ignore fields introduced by a compatible producer."""
    schema = _load(SCHEMA_ROOT / "research-chain.v1.json")
    example = _load(EXAMPLE_ROOT / "research-chain.v1.json")
    example["future_optional_field"] = {"producer_version": "v2"}
    _validate_minimal_schema(schema, example)
    assert schema["additionalProperties"] is True


def test_taxonomy_and_error_code_examples_cover_phase_zero_dictionaries():
    """The frozen dictionaries contain all names required by Phase 0."""
    taxonomy = _load(EXAMPLE_ROOT / "taxonomy.v1.json")
    errors = _load(EXAMPLE_ROOT / "error-codes.v1.json")
    assert "DEGRADED" in taxonomy["event_types"]
    assert {"LINK_ONLY", "HIDDEN"}.issubset(taxonomy["degraded_modes"])
    assert {"OPEN", "DONE", "DEGRADED"}.issubset(taxonomy["todo_statuses"])
    assert {
        "RESEARCH_DISABLED",
        "CHAIN_NOT_FOUND",
        "CHAIN_ACCESS_DENIED",
        "INVALID_TRANSITION",
        "IDEMPOTENCY_CONFLICT",
        "ACCOUNT_LINK_CONFLICT",
        "UPSTREAM_TIMEOUT",
        "UPSTREAM_DEGRADED",
    }.issubset({item["code"] for item in errors["codes"]})
