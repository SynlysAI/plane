"""Small helpers for request-id idempotency on Phase 0 writes."""

import hashlib
import json

from django.db import IntegrityError

from plane.research.utils.errors import ResearchErrorCode, research_conflict


def payload_hash(payload):
    """Create a stable hash for an incoming JSON payload."""
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def request_id_from(request):
    """Read the required idempotency key from the request headers or body."""
    return str(request.headers.get("X-Request-Id") or request.data.get("request_id") or "").strip()


def conflict_response():
    """Return the standard idempotency conflict response."""
    return research_conflict(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id was already used with another payload.")


def is_integrity_conflict(error):
    """Identify a uniqueness violation raised by a request-id race."""
    return isinstance(error, IntegrityError) and "request" in str(error).lower()
