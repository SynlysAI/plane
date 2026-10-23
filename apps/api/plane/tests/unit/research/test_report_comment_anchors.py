"""Pure validation tests for periodic-report comment anchors."""

from types import SimpleNamespace

import pytest
from django.test import SimpleTestCase

from plane.research.utils.report_comment_anchors import (
    ReportAnchorError,
    resolve_anchor_text,
    snapshot_content_hash,
    validate_report_anchor,
)

pytestmark = pytest.mark.unit


DOCUMENT = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "attrs": {"id": "block-method"},
            "content": [{"type": "text", "text": "本週完成催化劑活性實驗，結果穩定。"}],
        },
        {
            "type": "paragraph",
            "attrs": {"id": "block-next"},
            "content": [{"type": "text", "text": "下一步將開展重複實驗。"}],
        },
    ],
}


def anchor(**overrides):
    return {
        "version": 1,
        "block_id": "block-method",
        "block_type": "paragraph",
        "selected_text": "催化劑活性實驗",
        "prefix": "本週完成",
        "suffix": "，結果穩定",
        "start_offset": 4,
        "end_offset": 11,
        **overrides,
    }


class ReportCommentAnchorTests(SimpleTestCase):
    def test_validates_anchor_against_the_stable_snapshot_block(self):
        validated = validate_report_anchor(DOCUMENT, anchor())

        assert validated == anchor()

    def test_rejects_foreign_text_or_offsets(self):
        with pytest.raises(ReportAnchorError):
            validate_report_anchor(DOCUMENT, anchor(selected_text="下一步"))
        with pytest.raises(ReportAnchorError):
            validate_report_anchor(DOCUMENT, anchor(start_offset=5))
        with pytest.raises(ReportAnchorError):
            validate_report_anchor(DOCUMENT, anchor(block_id="missing"))

    def test_resolves_edited_block_only_when_the_match_is_unique(self):
        current = "完成催化劑活性實驗後，又補充催化劑活性實驗。"

        assert resolve_anchor_text("本週完成催化劑活性實驗，結果穩定。", anchor()) == 4
        assert resolve_anchor_text("完成催化劑活性實驗。", anchor()) == 2
        assert resolve_anchor_text(current, anchor()) is None
        assert resolve_anchor_text("此段已刪除。", anchor()) is None

    def test_snapshot_hash_is_deterministic(self):
        first = snapshot_content_hash(SimpleNamespace(description_json=DOCUMENT))
        second = snapshot_content_hash(
            SimpleNamespace(
                description_json={
                    "content": list(reversed(DOCUMENT["content"])),
                    "type": "doc",
                }
            )
        )

        assert first == snapshot_content_hash(SimpleNamespace(description_json=DOCUMENT))
        assert first != second
