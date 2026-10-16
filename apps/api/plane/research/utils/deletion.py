"""Dependency guards for deleting mistakenly created research records."""

from plane.db.models import ResearchChainNodeTask, ResearchOutcomeLink


def node_deletion_reason(node):
    if node.status != "DRAFT":
        return "Only draft nodes can be deleted; archive nodes that have started."
    if node.events.exclude(event_type="NODE_CREATED").exists() or node.snapshots.exists():
        return "This node has process records or snapshots and cannot be deleted."
    for name in (
        "children",
        "tasks",
        "uploads",
        "analysis_results",
        "reflections",
        "paper_reviews",
        "agent_sessions",
        "context_grants",
    ):
        if getattr(node, name).exists():
            return "This node has related nodes, tasks, files or reviews; remove those associations first."
    return ""


def report_deletion_reason(report):
    if report.status != "DRAFT" or report.submitted_at or report.official_snapshots.exists():
        return "Reports with submission history cannot be deleted."
    if (
        ResearchOutcomeLink.objects.filter(target_type="PERIODIC_REPORT", target_id=report.pk).exists()
        or ResearchChainNodeTask.objects.filter(resource_type="REPORT", resource_id=report.pk).exists()
    ):
        return "This report is linked to an outcome or task; remove the link first."
    return ""


def outcome_deletion_reason(outcome):
    if outcome.status != "DRAFT":
        return "Only draft outcomes can be deleted."
    if (
        outcome.links.exists()
        or outcome.paper_reviews.exists()
        or ResearchChainNodeTask.objects.filter(resource_type="OUTCOME", resource_id=outcome.pk).exists()
    ):
        return "This outcome has linked records or paper reviews; remove those associations first."
    return ""


def project_deletion_reason(project):
    chain = getattr(project, "research_chain", None)
    if chain and chain.nodes.exists():
        return "This project has research nodes; delete unused draft nodes first, or archive the project."
    business_models = {
        "issue",
        "cycle",
        "module",
        "projectpage",
        "periodicreport",
        "periodicreportprojectreference",
        "researchoutcome",
        "literatureentry",
        "experimentrecord",
        "projectcoderepository",
        "approvalrequest",
        "researchagentsession",
        "draftissue",
    }
    for relation in project._meta.related_objects:
        if relation.related_model._meta.model_name not in business_models:
            continue
        if relation.related_model.objects.filter(**{relation.field.name: project}).exists():
            return (
                "This project has related work items, reports or research records; "
                "remove those associations first, or archive it."
            )
    for stage in project.research_stage_instances.all():
        if stage.status != "NOT_STARTED" or stage.materials.exists() or stage.transitions.exists():
            return "This project has stage records and cannot be deleted; archive it instead."
    return ""
