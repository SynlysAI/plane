// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, expect, it, vi } from "vitest";
import type { TProject } from "@plane/types";

vi.mock("@makeplane/propel/components/field", () => ({
  Field: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@makeplane/propel/components/input", () => ({
  InputGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: ({ size: _size, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { size?: string }) => (
    <input {...props} />
  ),
}));
vi.mock("@makeplane/propel/components/text-area", () => ({
  TextAreaGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextArea: ({ size: _size, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { size?: string }) => (
    <textarea {...props} />
  ),
}));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import ProjectCommonAttributes from "@/components/project/create/common-attributes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
});

function TestForm() {
  const methods = useForm<TProject>({ defaultValues: { name: "", identifier: "", description: "" } });
  const [autoSync, setAutoSync] = useState(true);
  return (
    <FormProvider {...methods}>
      <ProjectCommonAttributes
        setValue={methods.setValue}
        isMobile={false}
        shouldAutoSyncIdentifier={autoSync}
        setShouldAutoSyncIdentifier={setAutoSync}
      />
    </FormProvider>
  );
}

async function enter(id: string, value: string) {
  const input = container.querySelector(`#${id}`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

it("fills a valid project code from a Chinese name and preserves a manual edit", async () => {
  root = createRoot(container);
  await act(async () => root.render(<TestForm />));

  await enter("name", "基于微纳加工器件的光电外场调控研究");
  const identifier = container.querySelector("#identifier") as HTMLInputElement;
  expect(identifier.value).toMatch(/^PRJ[A-Z0-9]{7}$/);
  expect(container.textContent).not.toContain("project_id_is_required");

  await enter("identifier", "CUSTOM");
  await enter("name", "另一个中文项目");
  expect(identifier.value).toBe("CUSTOM");
});
