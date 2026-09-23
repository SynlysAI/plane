# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research chain reference list (P1-CHAIN-07).

The export contains references and summaries only - never raw data, never a
copy of a body. It is produced from the same ACL filtered sources the timeline
uses, so the file matches what the caller may already read.
"""

from django.utils import timezone


def build_chain_markdown(progress, project_name, *, generated_by="", chain=None, timeline=None):
    """Render the reference list as Markdown, optionally for one chain."""
    if chain == "thinking":
        progress = {
            **progress,
            "experiments": {"items": [], "completed": 0, "total": 0},
            "code": {"repositories": [], "artifact_count": 0, "snapshot_count": 0},
            "outcomes": {"items": [], "count": 0},
        }
    elif chain == "development":
        progress = {
            **progress,
            "literature": {"items": [], "included": 0},
            "reports": {"items": [], "count": 0},
        }
    today = timezone.localdate().isoformat()
    timeline_items = (timeline or {}).get("items", [])
    if chain:
        timeline_items = [item for item in timeline_items if chain in item.get("chains", [])]
    chain_events = sorted(
        (item for item in timeline_items if item.get("kind") == "chain_event"),
        key=lambda item: (item.get("at") or "", item.get("event_id") or ""),
    )
    chain_snapshots = sorted(
        (item for item in timeline_items if item.get("kind") == "chain_snapshot"),
        key=lambda item: (item.get("at") or "", item.get("version") or 0),
    )
    lines = [
        f"# Research chain — {project_name}",
        "",
        f"Generated: {today}" + (f" by {generated_by}" if generated_by else ""),
        f"Degraded sources: {', '.join((timeline or {}).get('degraded_sources', [])) or 'none'}",
        "",
        "## Research Chain events",
        "",
    ]
    if chain_events:
        for item in chain_events:
            summary = str(item.get("title") or "").replace("\n", " ")
            lines.append(
                f"- `{item.get('event_id')}` {item.get('event_type')} "
                f"({item.get('source_system')}, `{item.get('content_hash')}`) — {summary}"
            )
    else:
        lines.append("- (none)")
    lines += [
        "",
        "## Research Chain snapshots",
        "",
    ]
    if chain_snapshots:
        for item in chain_snapshots:
            event_range = item.get("event_range") or {}
            lines.append(
                f"- v{item.get('version')} `{item.get('snapshot_id')}` "
                f"resources={len(item.get('resources') or [])} "
                f"events={event_range.get('first', '')}..{event_range.get('last', '')} "
                f"`{item.get('content_hash')}`"
            )
    else:
        lines.append("- (none)")
    lines += [
        "## Experiments",
        "",
    ]
    experiments = progress.get("experiments", {})
    if experiments.get("items"):
        for item in experiments["items"]:
            note = f" ({item['status_note']})" if item.get("status_note") else ""
            lines.append(f"- #{item['sequence_no']} {item['title']} — {item['status']}{note}")
    else:
        lines.append("- (none)")

    code = progress.get("code", {})
    lines += [
        "",
        "## Code",
        "",
        f"- Repositories: {len(code.get('repositories', []))}",
        f"- Artifacts: {code.get('artifact_count', 0)}",
        f"- Snapshots: {code.get('snapshot_count', 0)}",
    ]
    for repository in code.get("repositories", []):
        lines.append(f"- {repository['repository_url']} ({repository['provider']}, {repository['status']})")

    lines += ["", "## Literature", ""]
    literature = progress.get("literature", {})
    if literature.get("items"):
        for entry in literature["items"]:
            year = f" ({entry['year']})" if entry.get("year") else ""
            lines.append(f"- {entry['title']}{year}")
    else:
        lines.append(f"- Included references: {literature.get('included', 0)}")

    lines += ["", "## Reports", ""]
    reports = progress.get("reports", {})
    if reports.get("items"):
        for report in reports["items"]:
            lines.append(f"- {report['report_type']} {report['period_key']} — {report['status']}")
    else:
        lines.append("- (none)")

    lines += ["", "## Outcomes", ""]
    outcomes = progress.get("outcomes", {})
    if outcomes.get("items"):
        for outcome in outcomes["items"]:
            lines.append(f"- [{outcome['output_type']}] {outcome['title']} — {outcome['status']}")
    else:
        lines.append(f"- Registered outcomes: {outcomes.get('count', 0)}")

    lines += [
        "",
        "---",
        "This list references source objects only; original data and file bodies stay in the",
        "systems that own them (SpecLabOS, SmartAccess, RAGPortal, Poly_Agent, Spec_Agent).",
        "",
    ]
    return "\n".join(lines)
