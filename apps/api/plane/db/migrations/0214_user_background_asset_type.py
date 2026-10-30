from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0213_project_administrative_settings_lock"),
    ]

    operations = [
        migrations.AlterField(
            model_name="fileasset",
            name="entity_type",
            field=models.CharField(
                blank=True,
                choices=[
                    ("ISSUE_ATTACHMENT", "Issue Attachment"),
                    ("ISSUE_DESCRIPTION", "Issue Description"),
                    ("COMMENT_DESCRIPTION", "Comment Description"),
                    ("COMMENT_ATTACHMENT", "Comment Attachment"),
                    ("PAGE_DESCRIPTION", "Page Description"),
                    ("USER_COVER", "User Cover"),
                    ("USER_AVATAR", "User Avatar"),
                    ("USER_BACKGROUND", "User Background"),
                    ("WORKSPACE_LOGO", "Workspace Logo"),
                    ("PROJECT_COVER", "Project Cover"),
                    ("DRAFT_ISSUE_ATTACHMENT", "Draft Issue Attachment"),
                    ("DRAFT_ISSUE_DESCRIPTION", "Draft Issue Description"),
                    ("REPORT_ATTACHMENT", "Report Attachment"),
                    ("REPORT_IMAGE", "Report Image"),
                    ("RESEARCH_TASK_INSTRUCTION_ATTACHMENT", "Research Task Instruction Attachment"),
                    ("RESEARCH_TASK_INSTRUCTION_IMAGE", "Research Task Instruction Image"),
                    ("RESEARCH_TASK_COMMENT_ATTACHMENT", "Research Task Comment Attachment"),
                    ("RESEARCH_TASK_COMMENT_IMAGE", "Research Task Comment Image"),
                    ("FEEDBACK_SCREENSHOT", "Feedback Screenshot"),
                ],
                max_length=255,
                null=True,
            ),
        ),
    ]
