"""Token issuance checks with the grant manager mocked; no database writes."""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from django.utils import timezone

from plane.research.services.context_tokens import issue_context_token, hash_context_token
from plane.research.services.token_lifetimes import node_mcp_token_ttl_seconds


@override_settings(RESEARCH_CONTEXT_TOKEN_TTL_SECONDS=600, RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=604800)
class ContextTokenLifetimeTests(SimpleTestCase):
    def issue(self, **extra):
        now = timezone.now()
        with patch("plane.research.services.context_tokens.ResearchContextGrant.objects.create") as create:
            with patch("plane.research.services.context_tokens.timezone.now", return_value=now):
                _, raw = issue_context_token(
                    workspace=SimpleNamespace(id="workspace"), user=SimpleNamespace(id="user"),
                    profile=SimpleNamespace(project_id="project", chain_visibility="PRIVATE"),
                    chain_node=SimpleNamespace(id="node"), request_id="isolated-lifetime-test", **extra,
                )
            values = create.call_args.kwargs
        self.assertEqual(values["token_hash"], hash_context_token(raw))
        return values["expires_at"] - now

    def test_node_connection_issued_for_seven_days(self):
        self.assertEqual(self.issue(ttl_seconds=node_mcp_token_ttl_seconds()), timedelta(days=7))

    def test_legacy_exchange_retains_ten_minutes(self):
        self.assertEqual(self.issue(), timedelta(seconds=600))

    @override_settings(RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=86400)
    def test_explicit_node_configuration_is_used(self):
        self.assertEqual(self.issue(ttl_seconds=node_mcp_token_ttl_seconds()), timedelta(days=1))

    @override_settings(RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=1)
    def test_node_minimum_remains_sixty_seconds(self):
        self.assertEqual(self.issue(ttl_seconds=node_mcp_token_ttl_seconds()), timedelta(seconds=60))
