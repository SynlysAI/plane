import { describe, expect, it } from "vitest";

import { getResearchErrorDetail, getResearchErrorKey } from "@/components/research/common/error-messages";

describe("research upload errors", () => {
  it("maps storage failures to a specific localized message", () => {
    expect(getResearchErrorKey({ error_code: "research_upload_storage_failed" })).toBe(
      "research.errors.upload_storage_failed"
    );
  });

  it("maps registration failures separately from storage failures", () => {
    expect(getResearchErrorKey({ error_code: "research_upload_registration_failed" })).toBe(
      "research.errors.upload_registration_failed"
    );
  });

  it("truncates object storage response details before rendering", () => {
    const detail = getResearchErrorDetail({ message: "x".repeat(500) });
    expect(detail).toHaveLength(240);
  });
});
