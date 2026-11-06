# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json
import logging
import uuid
from datetime import timedelta
from uuid import UUID


# Module imports
from plane.db.models import (
    IssueMention,
    IssueSubscriber,
    Project,
    User,
    IssueAssignee,
    Issue,
    State,
    EmailNotificationLog,
    Notification,
    IssueComment,
    UserNotificationPreference,
    ProjectMember,
)

# Third Party imports
from celery import shared_task
from django.utils import timezone
from django.db import transaction
from plane.utils.administrative_projects import project_member_roster
from plane.utils.notification_outbox import persist_issue_notification_batch
from plane.utils.mentions import mentioned_user_ids, mention_receivers

logger = logging.getLogger("plane.worker")


# =========== Issue Description Html Parsing and notification Functions ======================


def update_mentions_for_issue(issue, project, new_mentions, removed_mention):
    aggregated_issue_mentions = []
    for mention_id in new_mentions:
        aggregated_issue_mentions.append(
            IssueMention(
                mention_id=mention_id,
                issue=issue,
                project=project,
                workspace_id=project.workspace_id,
            )
        )

    IssueMention.objects.bulk_create(aggregated_issue_mentions, batch_size=100)
    IssueMention.objects.filter(issue=issue, mention__in=removed_mention).delete()


def get_new_mentions(requested_instance, current_instance):
    # requested_data is the newer instance of the current issue
    # current_instance is the older instance of the current issue, saved in the database

    # extract mentions from both the instance of data
    mentions_older = extract_mentions(current_instance)

    mentions_newer = extract_mentions(requested_instance)

    # Getting Set Difference from mentions_newer
    new_mentions = [mention for mention in mentions_newer if mention not in mentions_older]

    return new_mentions


# Get Removed Mention
def get_removed_mentions(requested_instance, current_instance):
    # requested_data is the newer instance of the current issue
    # current_instance is the older instance of the current issue, saved in the database

    # extract mentions from both the instance of data
    mentions_older = extract_mentions(current_instance)
    mentions_newer = extract_mentions(requested_instance)

    # Getting Set Difference from mentions_newer
    removed_mentions = [mention for mention in mentions_older if mention not in mentions_newer]

    return removed_mentions


# Adds mentions as subscribers
def extract_mentions_as_subscribers(project_id, issue_id, mentions):
    # mentions is an array of User IDs representing the FILTERED set of mentioned users

    bulk_mention_subscribers = []

    for mention_id in mentions:
        # If the particular mention has not already been subscribed to the issue, he must be sent the mentioned notification # noqa: E501
        if (
            not IssueSubscriber.objects.filter(
                issue_id=issue_id, subscriber_id=mention_id, project_id=project_id
            ).exists()
            and not IssueAssignee.objects.filter(
                project_id=project_id, issue_id=issue_id, assignee_id=mention_id
            ).exists()
            and not Issue.objects.filter(project_id=project_id, pk=issue_id, created_by_id=mention_id).exists()
            and ProjectMember.objects.filter(project_id=project_id, member_id=mention_id, is_active=True).exists()
        ):
            project = Project.objects.get(pk=project_id)

            bulk_mention_subscribers.append(
                IssueSubscriber(
                    workspace_id=project.workspace_id,
                    project_id=project_id,
                    issue_id=issue_id,
                    subscriber_id=mention_id,
                )
            )
    return bulk_mention_subscribers


# Parse Issue Description & extracts mentions
def extract_mentions(issue_instance):
    try:
        # issue_instance has to be a dictionary passed, containing the description_html and other set of activity data. # noqa: E501
        # Convert string to dictionary
        data = json.loads(issue_instance)
        return sorted(mentioned_user_ids(data.get("description_html")))
    except Exception:
        return []


# =========== Comment Parsing and notification Functions ======================
def extract_comment_mentions(comment_value):
    """逐个解析合法用户提及，异常 UUID 不影响其他通知。"""
    return sorted(mentioned_user_ids(comment_value))


def get_new_comment_mentions(new_value, old_value):
    mentions_newer = extract_comment_mentions(new_value)
    if old_value is None:
        return mentions_newer

    mentions_older = extract_comment_mentions(old_value)
    # Getting Set Difference from mentions_newer
    new_mentions = [mention for mention in mentions_newer if mention not in mentions_older]

    return new_mentions


def create_mention_notification(project, notification_comment, issue, actor_id, mention_id, issue_id, activity):
    return Notification(
        workspace=project.workspace,
        sender="in_app:issue_activities:mentioned",
        triggered_by_id=actor_id,
        receiver_id=mention_id,
        entity_identifier=issue_id,
        entity_name="issue",
        project=project,
        message=notification_comment,
        data={
            **({"comment_id": str(activity["issue_comment"])} if activity.get("issue_comment") else {}),
            "issue": {
                "id": str(issue_id),
                "name": str(issue.name),
                "identifier": str(issue.project.identifier),
                "sequence_id": issue.sequence_id,
                "state_name": issue.state.name,
                "state_group": issue.state.group,
            },
            "issue_activity": {
                "id": str(activity.get("id")),
                "verb": str(activity.get("verb")),
                "field": str(activity.get("field")),
                "actor": str(activity.get("actor_id")),
                "new_value": str(activity.get("new_value")),
                "old_value": str(activity.get("old_value")),
                "old_identifier": (str(activity.get("old_identifier")) if activity.get("old_identifier") else None),
                "new_identifier": (str(activity.get("new_identifier")) if activity.get("new_identifier") else None),
            },
        },
    )


def get_notification_preference(user_id):
    """Return a user's preference row or an unsaved row with safe defaults."""
    return UserNotificationPreference.objects.filter(user_id=user_id).first() or UserNotificationPreference(
        user_id=user_id
    )


@shared_task(autoretry_for=(Exception,), retry_kwargs={"max_retries": 5}, retry_backoff=True)
@transaction.atomic
def notifications(
    type,
    issue_id,
    project_id,
    actor_id,
    subscriber,
    issue_activities_created,
    requested_data,
    current_instance,
):
    try:
        issue_activities_created = json.loads(issue_activities_created) if issue_activities_created else []
        if type not in [
            "cycle.activity.created",
            "cycle.activity.deleted",
            "module.activity.created",
            "module.activity.deleted",
            "issue_reaction.activity.created",
            "issue_reaction.activity.deleted",
            "comment_reaction.activity.created",
            "comment_reaction.activity.deleted",
            "issue_vote.activity.created",
            "issue_vote.activity.deleted",
            "issue_draft.activity.created",
            "issue_draft.activity.updated",
            "issue_draft.activity.deleted",
        ]:
            # Create Notifications
            bulk_notifications = []
            bulk_email_logs = []

            """
            Mention Tasks
            1. Perform Diffing and Extract the mentions, that mention notification needs to be sent
            2. From the latest set of mentions, extract the users which are not a subscribers & make them subscribers
            """

            # Direct project members and inherited administrative organization members
            # share the same notification boundary.
            project = Project.objects.get(pk=project_id)
            project_members = {UUID(row["member"]) for row in project_member_roster(project)}
            source_issue = Issue.objects.filter(pk=issue_id, project=project).first()

            # Get new mentions from the newer instance
            new_mentions = get_new_mentions(requested_instance=requested_data, current_instance=current_instance)
            new_mentions = (
                [str(user.pk) for user in mention_receivers("issue", source_issue, new_mentions)]
                if source_issue
                else []
            )
            removed_mention = get_removed_mentions(requested_instance=requested_data, current_instance=current_instance)

            comment_mentions = []
            all_comment_mentions = []
            comment_mention_activities = {}

            # Get New Subscribers from the mentions of the newer instance
            requested_mentions = extract_mentions(issue_instance=requested_data)
            mention_subscribers = extract_mentions_as_subscribers(
                project_id=project_id, issue_id=issue_id, mentions=requested_mentions
            )

            for issue_activity in issue_activities_created:
                issue_comment = issue_activity.get("issue_comment")
                issue_comment_new_value = issue_activity.get("new_value")
                issue_comment_old_value = issue_activity.get("old_value")
                if issue_comment is not None:
                    # TODO: Maybe save the comment mentions, so that in future, we can filter out the issues based on comment mentions as well.

                    all_comment_mentions = all_comment_mentions + extract_comment_mentions(issue_comment_new_value)

                    new_comment_mentions = get_new_comment_mentions(
                        old_value=issue_comment_old_value,
                        new_value=issue_comment_new_value,
                    )
                    valid_comment_mentions = (
                        [str(user.pk) for user in mention_receivers("issue", source_issue, new_comment_mentions)]
                        if source_issue
                        else []
                    )
                    comment_mentions.extend(valid_comment_mentions)
                    for mention in valid_comment_mentions:
                        comment_mention_activities.setdefault(mention, []).append(issue_activity)

            comment_mention_subscribers = extract_mentions_as_subscribers(
                project_id=project_id, issue_id=issue_id, mentions=all_comment_mentions
            )
            """
            We will not send subscription activity notification to the below mentioned user sets
            - Those who have been newly mentioned in the issue description, we will send mention notification to them.
            - When the activity is a comment_created and there exist a mention in the comment, 
              then we have to send the "mention_in_comment" notification
            - When the activity is a comment_updated and there exist a mention change, 
              then also we have to send the "mention_in_comment" notification
            """

            # ---------------------------------------------------------------------------------------------------------
            issue_subscribers = list(
                IssueSubscriber.objects.filter(
                    project_id=project_id,
                    issue_id=issue_id,
                    subscriber_id__in=project_members,
                )
                .exclude(subscriber_id__in=list(new_mentions + comment_mentions + [actor_id]))
                .values_list("subscriber", flat=True)
            )

            issue = Issue.objects.filter(pk=issue_id).first()
            assignment_activities = [
                activity
                for activity in issue_activities_created
                if activity.get("field") == "assignees" and activity.get("new_identifier")
            ]
            assigned_receiver_ids = {
                str(UUID(activity.get("new_identifier")))
                for activity in assignment_activities
                if activity.get("new_identifier")
            }

            if subscriber:
                # add the user to issue subscriber
                try:
                    _ = IssueSubscriber.objects.get_or_create(
                        project_id=project_id,
                        issue_id=issue_id,
                        subscriber_id=actor_id,
                        source=IssueSubscriber.Source.SELF,
                    )
                except Exception:
                    pass

            issue_assignees = IssueAssignee.objects.filter(
                issue_id=issue_id,
                project_id=project_id,
                assignee_id__in=project_members,
            ).values_list("assignee", flat=True)

            issue_subscribers = list(
                set(issue_subscribers)
                - {uuid.UUID(actor_id)}
                - {uuid.UUID(receiver_id) for receiver_id in assigned_receiver_ids}
            )

            for subscriber in issue_subscribers:
                if issue.created_by_id and issue.created_by_id == subscriber:
                    sender = "in_app:issue_activities:created"
                elif subscriber in issue_assignees and issue.created_by_id not in issue_assignees:
                    sender = "in_app:issue_activities:assigned"
                else:
                    sender = "in_app:issue_activities:subscribed"

                preference = get_notification_preference(subscriber)

                for issue_activity in issue_activities_created:
                    # Assignment notifications are sent only to the newly assigned owner below.
                    if issue_activity.get("field") == "assignees":
                        continue

                    # If activity done in blocking then blocked by email should not go
                    activity_issue = issue_activity.get("issue_detail") or {}
                    if activity_issue.get("id") and str(activity_issue.get("id")) != str(issue_id):
                        continue

                    # Do not send notification for description update
                    if issue_activity.get("field") == "description":
                        continue

                    # Check if the value should be sent or not
                    send_email = False
                    if issue_activity.get("field") == "state":
                        is_completed = State.objects.filter(
                            project_id=project_id,
                            pk=issue_activity.get("new_identifier"),
                            group="completed",
                        ).exists()
                        send_email = preference.issue_completed if is_completed else preference.state_change
                    elif issue_activity.get("field") == "comment" and preference.comment:
                        send_email = True
                    elif issue_activity.get("field") != "comment" and preference.property_change:
                        send_email = True
                    else:
                        send_email = False

                    # If activity is of issue comment fetch the comment
                    issue_comment = (
                        IssueComment.objects.filter(
                            id=issue_activity.get("issue_comment"),
                            issue_id=issue_id,
                            project_id=project_id,
                            workspace_id=project.workspace_id,
                        ).first()
                        if issue_activity.get("issue_comment")
                        else None
                    )

                    # Create in app notification
                    bulk_notifications.append(
                        Notification(
                            workspace=project.workspace,
                            sender=sender,
                            triggered_by_id=actor_id,
                            receiver_id=subscriber,
                            entity_identifier=issue_id,
                            entity_name="issue",
                            project=project,
                            title=issue_activity.get("comment"),
                            data={
                                "issue": {
                                    "id": str(issue_id),
                                    "name": str(issue.name),
                                    "identifier": str(issue.project.identifier),
                                    "sequence_id": issue.sequence_id,
                                    "state_name": issue.state.name,
                                    "state_group": issue.state.group,
                                },
                                "issue_activity": {
                                    "id": str(issue_activity.get("id")),
                                    "verb": str(issue_activity.get("verb")),
                                    "field": str(issue_activity.get("field")),
                                    "actor": str(issue_activity.get("actor_id")),
                                    "new_value": str(issue_activity.get("new_value")),
                                    "old_value": str(issue_activity.get("old_value")),
                                    "issue_comment": str(
                                        issue_comment.comment_stripped if issue_comment is not None else ""
                                    ),
                                    "old_identifier": (
                                        str(issue_activity.get("old_identifier"))
                                        if issue_activity.get("old_identifier")
                                        else None
                                    ),
                                    "new_identifier": (
                                        str(issue_activity.get("new_identifier"))
                                        if issue_activity.get("new_identifier")
                                        else None
                                    ),
                                },
                            },
                        )
                    )
                    # Create email notification
                    if send_email:
                        bulk_email_logs.append(
                            EmailNotificationLog(
                                triggered_by_id=actor_id,
                                receiver_id=subscriber,
                                entity_identifier=issue_id,
                                entity_name="issue",
                                available_at=timezone.now() + timedelta(minutes=5),
                                data={
                                    "issue": {
                                        "id": str(issue_id),
                                        "name": str(issue.name),
                                        "identifier": str(issue.project.identifier),
                                        "project_id": str(issue.project.id),
                                        "workspace_slug": str(issue.project.workspace.slug),
                                        "sequence_id": issue.sequence_id,
                                        "state_name": issue.state.name,
                                        "state_group": issue.state.group,
                                    },
                                    "issue_activity": {
                                        "id": str(issue_activity.get("id")),
                                        "verb": str(issue_activity.get("verb")),
                                        "field": str(issue_activity.get("field")),
                                        "actor": str(issue_activity.get("actor_id")),
                                        "new_value": str(issue_activity.get("new_value")),
                                        "old_value": str(issue_activity.get("old_value")),
                                        "issue_comment": str(
                                            issue_comment.comment_stripped if issue_comment is not None else ""
                                        ),
                                        "old_identifier": (
                                            str(issue_activity.get("old_identifier"))
                                            if issue_activity.get("old_identifier")
                                            else None
                                        ),
                                        "new_identifier": (
                                            str(issue_activity.get("new_identifier"))
                                            if issue_activity.get("new_identifier")
                                            else None
                                        ),
                                        "activity_time": issue_activity.get("created_at"),
                                    },
                                },
                            )
                        )

            # Direct assignment notifications go only to the newly assigned user.
            for receiver_id in assigned_receiver_ids:
                if receiver_id == actor_id:
                    continue
                preference = get_notification_preference(receiver_id)
                for issue_activity in assignment_activities:
                    if str(UUID(issue_activity.get("new_identifier"))) != receiver_id:
                        continue
                    issue_payload = {
                        "id": str(issue_id),
                        "name": str(issue.name),
                        "identifier": str(issue.project.identifier),
                        "sequence_id": issue.sequence_id,
                        "state_name": issue.state.name,
                        "state_group": issue.state.group,
                    }
                    activity_payload = {
                        "id": str(issue_activity.get("id")),
                        "verb": str(issue_activity.get("verb")),
                        "field": str(issue_activity.get("field")),
                        "actor": str(issue_activity.get("actor_id")),
                        "new_value": str(issue_activity.get("new_value")),
                        "old_value": str(issue_activity.get("old_value")),
                        "old_identifier": str(issue_activity.get("old_identifier"))
                        if issue_activity.get("old_identifier")
                        else None,
                        "new_identifier": str(issue_activity.get("new_identifier"))
                        if issue_activity.get("new_identifier")
                        else None,
                    }
                    bulk_notifications.append(
                        Notification(
                            workspace=project.workspace,
                            sender="in_app:issue_activities:assigned",
                            triggered_by_id=actor_id,
                            receiver_id=receiver_id,
                            entity_identifier=issue_id,
                            entity_name="issue",
                            project=project,
                            title=issue_activity.get("comment"),
                            data={"issue": issue_payload, "issue_activity": activity_payload},
                        )
                    )
                    if preference.assignment:
                        bulk_email_logs.append(
                            EmailNotificationLog(
                                triggered_by_id=actor_id,
                                receiver_id=receiver_id,
                                entity_identifier=issue_id,
                                entity_name="issue",
                                immediate=True,
                                data={
                                    "issue": issue_payload
                                    | {
                                        "project_id": str(issue.project.id),
                                        "workspace_slug": str(issue.project.workspace.slug),
                                    },
                                    "issue_activity": activity_payload
                                    | {"activity_time": issue_activity.get("created_at")},
                                },
                            )
                        )

            # -------------------------------------------------------------------------------------------------------- #

            # Add Mentioned as Issue Subscribers
            IssueSubscriber.objects.bulk_create(
                mention_subscribers + comment_mention_subscribers,
                batch_size=100,
                ignore_conflicts=True,
            )

            actor = User.objects.get(pk=actor_id)

            for mention_id in comment_mentions:
                if mention_id != actor_id:
                    preference = get_notification_preference(mention_id)
                    for issue_activity in comment_mention_activities.get(mention_id, []):
                        notification = create_mention_notification(
                            project=project,
                            issue=issue,
                            notification_comment=f"{actor.display_name} has mentioned you in a comment in issue {issue.name}",  # noqa: E501
                            actor_id=actor_id,
                            mention_id=mention_id,
                            issue_id=issue_id,
                            activity=issue_activity,
                        )

                        # check for email notifications
                        if preference.mention:
                            bulk_email_logs.append(
                                EmailNotificationLog(
                                    triggered_by_id=actor_id,
                                    receiver_id=mention_id,
                                    entity_identifier=issue_id,
                                    entity_name="issue",
                                    immediate=True,
                                    data={
                                        "issue": {
                                            "id": str(issue_id),
                                            "name": str(issue.name),
                                            "identifier": str(issue.project.identifier),
                                            "sequence_id": issue.sequence_id,
                                            "state_name": issue.state.name,
                                            "state_group": issue.state.group,
                                            "project_id": str(issue.project.id),
                                            "workspace_slug": str(issue.project.workspace.slug),
                                        },
                                        "issue_activity": {
                                            "id": str(issue_activity.get("id")),
                                            "verb": str(issue_activity.get("verb")),
                                            "field": str("mention"),
                                            "actor": str(issue_activity.get("actor_id")),
                                            "new_value": str(issue_activity.get("new_value")),
                                            "old_value": str(issue_activity.get("old_value")),
                                            "old_identifier": (
                                                str(issue_activity.get("old_identifier"))
                                                if issue_activity.get("old_identifier")
                                                else None
                                            ),
                                            "new_identifier": (
                                                str(issue_activity.get("new_identifier"))
                                                if issue_activity.get("new_identifier")
                                                else None
                                            ),
                                            "activity_time": issue_activity.get("created_at"),
                                        },
                                    },
                                )
                            )
                        bulk_notifications.append(notification)

            for mention_id in new_mentions:
                if mention_id != actor_id:
                    preference = get_notification_preference(mention_id)
                    description_activity = next(
                        (
                            activity
                            for activity in reversed(issue_activities_created)
                            if activity.get("field") == "description"
                            and str(activity.get("actor_id")) == str(actor_id)
                        ),
                        None,
                    )
                    if description_activity is not None:
                        bulk_notifications.append(
                            Notification(
                                workspace=project.workspace,
                                sender="in_app:issue_activities:mentioned",
                                triggered_by_id=actor_id,
                                receiver_id=mention_id,
                                entity_identifier=issue_id,
                                entity_name="issue",
                                project=project,
                                message=f"You have been mentioned in the issue {issue.name}",
                                data={
                                    "issue": {
                                        "id": str(issue_id),
                                        "name": str(issue.name),
                                        "identifier": str(issue.project.identifier),
                                        "sequence_id": issue.sequence_id,
                                        "state_name": issue.state.name,
                                        "state_group": issue.state.group,
                                        "project_id": str(issue.project.id),
                                        "workspace_slug": str(issue.project.workspace.slug),
                                    },
                                    "issue_activity": {
                                        "id": str(description_activity.get("id")),
                                        "verb": str(description_activity.get("verb")),
                                        "field": str(description_activity.get("field")),
                                        "actor": str(description_activity.get("actor_id")),
                                        "new_value": str(description_activity.get("new_value")),
                                        "old_value": str(description_activity.get("old_value")),
                                        "old_identifier": (
                                            str(description_activity.get("old_identifier"))
                                            if description_activity.get("old_identifier")
                                            else None
                                        ),
                                        "new_identifier": (
                                            str(description_activity.get("new_identifier"))
                                            if description_activity.get("new_identifier")
                                            else None
                                        ),
                                    },
                                },
                            )
                        )
                        if preference.mention:
                            bulk_email_logs.append(
                                EmailNotificationLog(
                                    triggered_by_id=actor_id,
                                    receiver_id=mention_id,
                                    entity_identifier=issue_id,
                                    entity_name="issue",
                                    immediate=True,
                                    data={
                                        "issue": {
                                            "id": str(issue_id),
                                            "name": str(issue.name),
                                            "identifier": str(issue.project.identifier),
                                            "sequence_id": issue.sequence_id,
                                            "state_name": issue.state.name,
                                            "state_group": issue.state.group,
                                        },
                                        "issue_activity": {
                                            "id": str(description_activity.get("id")),
                                            "verb": str(description_activity.get("verb")),
                                            "field": "mention",
                                            "actor": str(description_activity.get("actor_id")),
                                            "new_value": str(description_activity.get("new_value")),
                                            "old_value": str(description_activity.get("old_value")),
                                            "old_identifier": (
                                                str(description_activity.get("old_identifier"))
                                                if description_activity.get("old_identifier")
                                                else None
                                            ),
                                            "new_identifier": (
                                                str(description_activity.get("new_identifier"))
                                                if description_activity.get("new_identifier")
                                                else None
                                            ),
                                            "activity_time": description_activity.get("created_at"),
                                        },
                                    },
                                )
                            )

            # save new mentions for the particular issue and remove the mentions that has been deleted from the description # noqa: E501
            update_mentions_for_issue(
                issue=issue,
                project=project,
                new_mentions=new_mentions,
                removed_mention=removed_mention,
            )
            persist_issue_notification_batch(bulk_notifications, bulk_email_logs)
            if any(log.immediate for log in bulk_email_logs):
                from plane.bgtasks.email_notification_task import stack_email_notification

                transaction.on_commit(lambda: stack_email_notification.delay(), robust=True)
        return
    except Exception as e:
        logger.exception("Issue notification generation failed", exc_info=e)
        raise
