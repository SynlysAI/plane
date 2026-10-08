// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({ getChainPage: vi.fn(), getChains: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations) ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChainPage = mocks.getChainPage;
    getChains = mocks.getChains;
  },
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    fetchOrgUnits: async () => undefined,
    getOrgUnits: () => [{ id: "group-a", name: "Group A" }],
  }),
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    workspace: { fetchWorkspaceMembers: async () => undefined, getWorkspaceMemberIds: () => [] },
    getUserDetails: () => undefined,
  }),
}));
vi.mock("@plane/propel/button", () => ({
  getButtonStyling: () => "",
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
}));

const { ResearchChainBoard } = await import("@/components/research/chains/research-chain-board");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 为列表返回具有明确名称及游标的分页结果。 */
function page(name: string, next = false) {
  return {
    results: [
      {
        id: name,
        project: name,
        project_name: name,
        owner: "student-1",
        owner_name: "Student",
        status: "ACTIVE",
        visibility: "PRIVATE",
        updated_at: "2026-10-08T00:00:00Z",
      },
    ],
    next_cursor: "page-2",
    prev_cursor: "page-1",
    next_page_results: next,
    prev_page_results: !next,
  };
}

/** 显示真实路由 URL，并提供浏览器后退操作。 */
function LocationProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output aria-label="URL">{location.search}</output>
      <button onClick={() => navigate(-1)}>后退</button>
    </>
  );
}

/** 渲染实际研究链列表与 MemoryRouter，使筛选可通过历史回放。 */
async function render(entry = "/lab/research/chains?source=legacy&q=graphite&scope=owned&cursor=page-1") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <ResearchChainBoard workspaceSlug="lab" />
      </MemoryRouter>
    )
  );
}

/** 按可见文本点击操作按钮。 */
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  if (!button) throw new Error(`未找到按钮：${label}`);
  await act(async () => button.click());
}

/** 通过真实控件改变查询值，触发 URL 及网络请求。 */
async function change(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!input) throw new Error(`未找到筛选：${selector}`);
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

/** 为新旧查询建立确定性完成顺序。 */
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getChainPage.mockResolvedValue(page("Graphite first", true));
  mocks.getChains.mockResolvedValue(page("Legacy first").results);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("组合筛选从 URL 读取，分页写入游标，改变条件重置游标并可后退回放", async () => {
  await render();
  expect(mocks.getChainPage).toHaveBeenLastCalledWith("lab", {
    source: "legacy",
    q: "graphite",
    scope: "owned",
    cursor: "page-1",
  });
  expect(container.textContent).toContain("Graphite first");
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="范围"]')?.value).toBe("owned");
  await click("下一页");
  expect(mocks.getChainPage).toHaveBeenLastCalledWith(
    "lab",
    expect.objectContaining({ cursor: "page-2", q: "graphite" })
  );
  await change('select[aria-label="课题组"]', "group-a");
  expect(mocks.getChainPage).toHaveBeenLastCalledWith(
    "lab",
    expect.objectContaining({ org_unit: "group-a", q: "graphite" })
  );
  expect(
    new URLSearchParams(container.querySelector('output[aria-label="URL"]')?.textContent ?? "").has("cursor")
  ).toBe(false);
  await click("后退");
  expect(mocks.getChainPage).toHaveBeenLastCalledWith(
    "lab",
    expect.objectContaining({ cursor: "page-2", q: "graphite" })
  );
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="课题组"]')?.value).toBe("");
});

it("新关键词先返回后，陈旧研究链请求不能覆盖当前结果", async () => {
  const old = pending<ReturnType<typeof page>>();
  const fresh = pending<ReturnType<typeof page>>();
  mocks.getChainPage.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  await render();
  await change('input[aria-label="关键词"]', "silicon");
  await act(async () => fresh.resolve(page("Silicon fresh")));
  expect(container.textContent).toContain("Silicon fresh");

  await act(async () => old.resolve(page("Graphite stale")));

  expect(container.textContent).toContain("Silicon fresh");
  expect(container.textContent).not.toContain("Graphite stale");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="关键词"]')?.value).toBe("silicon");
});
