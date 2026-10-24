import type { JSONContent, TReportTemplateSection } from "@plane/types";

export type TTemplateSectionStat = {
  section: TReportTemplateSection;
  count: number;
};

/** Extract plain text from a ProseMirror-style JSON node. */
function nodeText(node: JSONContent | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(nodeText).join("");
}

/** Remove all whitespace so English words and Chinese characters count consistently. */
function compactText(value: string): string {
  return value.replace(/\s+/g, "");
}

/** Determine whether a paragraph is immutable template guidance rather than author input. */
function isGuidanceNode(node: JSONContent | undefined, section: TReportTemplateSection): boolean {
  if (!node || node.type !== "paragraph") return false;
  const text = compactText(nodeText(node));
  const guidance = compactText(section.guidance);
  if (!guidance) return false;
  return text === guidance || (text.startsWith(guidance) && text.length <= guidance.length + 20);
}

/** Calculate per-section character counts from a report document. */
export function templateSectionStats(
  document: JSONContent | string | null | undefined,
  sections: TReportTemplateSection[]
): TTemplateSectionStat[] {
  if (!document || typeof document === "string") return sections.map((section) => ({ section, count: 0 }));
  const nodes = Array.isArray(document.content) ? document.content : [];
  const headingPositions = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.type === "heading");

  return sections.map((section, sectionIndex) => {
    const matchedHeading = headingPositions.find(({ node }) => node.attrs?.id === section.id);
    const heading = matchedHeading ?? headingPositions[sectionIndex];
    if (!heading) return { section, count: 0 };

    const position = headingPositions.indexOf(heading);
    const nextHeading = headingPositions[position + 1];
    const body = nodes.slice(heading.index + 1, nextHeading ? nextHeading.index : nodes.length);
    const authorNodes = isGuidanceNode(body[0], section) ? body.slice(1) : body;
    return {
      section,
      count: compactText(authorNodes.map(nodeText).join("")).length,
    };
  });
}
