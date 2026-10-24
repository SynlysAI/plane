/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
// types
import type { TEditorCommentAnchor, TEditorSelectionAnchor } from "@/types";

type CommentAnchorState = {
  anchors: TEditorCommentAnchor[];
  activeThreadId: string | null;
  decorations: DecorationSet;
};

type CommentAnchorMeta = {
  anchors?: TEditorCommentAnchor[];
  activeThreadId?: string | null;
};

export const commentAnchorsPluginKey = new PluginKey<CommentAnchorState>("commentAnchors");

const ANCHOR_CLASS = "bg-accent-primary/10 underline decoration-accent-primary/40";
const ACTIVE_CLASS = "bg-accent-primary/20 underline decoration-accent-primary/70";

function blockTextPositions(block: ProseMirrorNode, blockPos: number): Array<{ index: number; pos: number }> {
  /** Map plain-text indices in one block to ProseMirror positions. */
  const positions: Array<{ index: number; pos: number }> = [];
  block.descendants((node, relativePos) => {
    if (!node.isText || !node.text) return true;
    for (let index = 0; index < node.text.length; index += 1) {
      positions.push({ index: positions.length, pos: blockPos + relativePos + index });
    }
    return false;
  });
  return positions;
}

function resolveAnchor(doc: ProseMirrorNode, comment: TEditorCommentAnchor): { from: number; to: number } | null {
  /** Resolve an anchor only within its original stable block. */
  let resolved: { from: number; to: number } | null = null;
  doc.descendants((block, blockPos) => {
    if (block.attrs?.id !== comment.anchor.block_id) return true;
    const positions = blockTextPositions(block, blockPos);
    const text = positions.map((item) => doc.textBetween(item.pos, item.pos + 1)).join("");
    let start: number | null = null;
    if (
      comment.anchor.start_offset >= 0 &&
      comment.anchor.end_offset <= text.length &&
      text.slice(comment.anchor.start_offset, comment.anchor.end_offset) === comment.anchor.selected_text
    ) {
      start = comment.anchor.start_offset;
    } else {
      const contextual = `${comment.anchor.prefix}${comment.anchor.selected_text}${comment.anchor.suffix}`;
      const contextualIndex = text.indexOf(contextual);
      if (contextualIndex >= 0) {
        start = contextualIndex + comment.anchor.prefix.length;
      } else {
        const first = text.indexOf(comment.anchor.selected_text);
        const second = first >= 0 ? text.indexOf(comment.anchor.selected_text, first + 1) : -1;
        if (first >= 0 && second < 0) start = first;
      }
    }
    if (start === null || !positions[start] || !positions[start + comment.anchor.selected_text.length - 1]) {
      resolved = null;
      return false;
    }
    resolved = {
      from: positions[start].pos,
      to: positions[start + comment.anchor.selected_text.length - 1].pos + 1,
    };
    return false;
  });
  return resolved;
}

function buildDecorations(
  doc: ProseMirrorNode,
  anchors: TEditorCommentAnchor[],
  activeThreadId: string | null
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const comment of anchors) {
    const range = resolveAnchor(doc, comment);
    if (!range) continue;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        "data-comment-thread-id": comment.threadId,
        "data-comment-anchor-resolved": "true",
        "aria-label": `定位批注 ${comment.threadId}`,
        role: "button",
        tabindex: "0",
        class: comment.threadId === activeThreadId ? ACTIVE_CLASS : ANCHOR_CLASS,
      })
    );
  }
  return DecorationSet.create(doc, decorations);
}

export function getSelectionAnchorFromDocument(
  doc: ProseMirrorNode,
  from: number,
  to: number
): TEditorSelectionAnchor | null {
  /** Extract a same-block stable selection anchor for report comments. */
  if (from >= to) return null;
  const $from = doc.resolve(from);
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const block = $from.node(depth);
    const blockId = block.attrs?.id;
    if (typeof blockId !== "string" || !blockId) continue;
    const blockPos = $from.before(depth);
    const blockEnd = $from.after(depth);
    if (to < blockPos || to > blockEnd) return null;

    const positions = blockTextPositions(block, blockPos);
    const findIndex = (position: number) => {
      let index = -1;
      for (let cursor = 0; cursor < positions.length; cursor += 1) {
        if (positions[cursor].pos <= position) index = cursor;
      }
      return index;
    };
    const startOffset = findIndex(from);
    const endOffset = findIndex(to - 1) + 1;
    if (startOffset < 0 || endOffset <= startOffset) return null;
    const textAt = (start: number, end: number) =>
      positions
        .slice(start, end)
        .map((item) => doc.textBetween(item.pos, item.pos + 1))
        .join("");
    const selectedText = textAt(startOffset, endOffset);
    if (!selectedText.trim()) return null;
    return {
      version: 1,
      block_id: blockId,
      block_type: block.type.name,
      selected_text: selectedText,
      prefix: textAt(Math.max(0, startOffset - 64), startOffset),
      suffix: textAt(endOffset, Math.min(positions.length, endOffset + 64)),
      start_offset: startOffset,
      end_offset: endOffset,
    };
  }
  return null;
}

export const CommentAnchors = Extension.create({
  name: "commentAnchors",

  addProseMirrorPlugins() {
    return [
      new Plugin<CommentAnchorState>({
        key: commentAnchorsPluginKey,
        state: {
          init: () => ({
            anchors: [],
            activeThreadId: null,
            decorations: DecorationSet.empty,
          }),
          apply: (tr: Transaction, value: CommentAnchorState) => {
            const meta = tr.getMeta(commentAnchorsPluginKey) as CommentAnchorMeta | undefined;
            let anchors = value.anchors;
            let activeThreadId = value.activeThreadId;
            let decorations = value.decorations;

            if (meta?.anchors) {
              anchors = meta.anchors;
            }
            if (meta?.activeThreadId !== undefined) {
              activeThreadId = meta.activeThreadId;
            }
            if (meta?.anchors !== undefined || meta?.activeThreadId !== undefined) {
              decorations = buildDecorations(tr.doc, anchors, activeThreadId);
            } else if (tr.docChanged) {
              decorations = decorations.map(tr.mapping, tr.doc);
            }
            return { anchors, activeThreadId, decorations };
          },
        },
        props: {
          decorations(state) {
            return commentAnchorsPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
