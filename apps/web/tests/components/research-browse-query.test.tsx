// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useResearchBrowseQuery } from "@/components/research/common/browse-query";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 用真实路由验证列表筛选、分页、视图和浏览器历史回放。 */
function BrowseProbe() {
  const query = useResearchBrowseQuery();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <output aria-label="URL">{location.search}</output>
      <output aria-label="筛选">{`${query.get("view", "reports")}|${query.get("scope", "all")}|${query.get("q")}|${query.get("cursor")}`}</output>
      <button onClick={() => query.patch({ scope: "mine", q: "graphite", owner: "student-1" })}>应用筛选</button>
      <button onClick={() => query.set("cursor", "page-2")}>下一页</button>
      <button onClick={() => query.set("view", "outcomes")}>成果视图</button>
      <button onClick={() => navigate(-1)}>后退</button>
      <button onClick={() => navigate(1)}>前进</button>
      <button onClick={() => query.patch({ scope: "all", q: "", owner: "" })}>全部可见</button>
    </div>
  );
}

/** 点击真实路由探针中的指定操作。 */
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  if (!button) throw new Error(`未找到操作：${label}`);
  await act(async () => button.click());
}

/** 返回页面呈现的当前 URL 参数。 */
function url() {
  return new URLSearchParams(container.querySelector('output[aria-label="URL"]')?.textContent ?? "");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("筛选、分页和视图切换写入 URL 并按浏览器历史完整回放", async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports?source=legacy&view=reports&cursor=old-page"]}>
        <BrowseProbe />
      </MemoryRouter>
    );
  });

  await click("应用筛选");
  expect(url().get("source")).toBe("legacy");
  expect(url().get("scope")).toBe("mine");
  expect(url().get("q")).toBe("graphite");
  expect(url().has("cursor")).toBe(false);
  await click("下一页");
  expect(url().get("cursor")).toBe("page-2");
  await click("成果视图");
  expect(url().get("view")).toBe("outcomes");
  expect(url().has("cursor")).toBe(false);
  expect(url().get("q")).toBe("graphite");

  await click("后退");
  expect(container.querySelector('output[aria-label="筛选"]')?.textContent).toBe("reports|mine|graphite|page-2");
  await click("后退");
  expect(container.querySelector('output[aria-label="筛选"]')?.textContent).toBe("reports|mine|graphite|");
  await click("前进");
  expect(url().get("cursor")).toBe("page-2");
  await click("前进");
  expect(url().get("view")).toBe("outcomes");
  await click("全部可见");
  expect(url().has("scope")).toBe(false);
  expect(url().has("q")).toBe(false);
  expect(url().has("owner")).toBe(false);
  expect(url().get("source")).toBe("legacy");
});

it("通过保存 URL 重新挂载页面恢复组合筛选与分页", async () => {
  const entry =
    "/lab/research/chains?view=projects&scope=participating&q=silicon&org_unit=group-a&owner=student-1&date_preset=custom&date_from=2026-10-01&date_to=2026-10-08&cursor=page-2";
  await act(async () =>
    root.render(
      <MemoryRouter key="initial" initialEntries={[entry]}>
        <BrowseProbe />
      </MemoryRouter>
    )
  );
  const saved = url().toString();

  await act(async () =>
    root.render(
      <MemoryRouter key="reload" initialEntries={[`/lab/research/chains?${saved}`]}>
        <BrowseProbe />
      </MemoryRouter>
    )
  );

  expect(container.querySelector('output[aria-label="筛选"]')?.textContent).toBe(
    "projects|participating|silicon|page-2"
  );
  expect(url().get("org_unit")).toBe("group-a");
  expect(url().get("date_from")).toBe("2026-10-01");
  expect(url().get("date_to")).toBe("2026-10-08");
});
