import { expect, it } from "vitest";
import {
  generateProjectIdentifierFallback,
  projectIdentifierFromName,
} from "@/components/project/create/project-identifier";

it("generates a valid project identifier when the name has no Latin letters", () => {
  const fallback = generateProjectIdentifierFallback();
  expect(fallback).toMatch(/^PRJ[A-Z0-9]{7}$/);
  expect(projectIdentifierFromName("基于微纳加工器件的光电外场调控研究", fallback)).toBe(fallback);
  expect(projectIdentifierFromName("项目 1", fallback)).toBe(fallback);
});

it("keeps readable identifiers for Latin names and clears with the name", () => {
  expect(projectIdentifierFromName("Research Project", "PRJ1234567")).toBe("ResearchPr");
  expect(projectIdentifierFromName("", "PRJ1234567")).toBe("");
  expect(projectIdentifierFromName("   ", "PRJ1234567")).toBe("");
});
