/* 在独立浏览器上下文中模拟全部 API，验证页面交互且不访问真实邮件服务。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = process.env.EMAIL_FILTER_BROWSER_URL || "http://127.0.0.1:3317/god-mode";
const output = process.env.EMAIL_FILTER_BROWSER_OUTPUT || "/tmp/plane-email-filters-browser";
const original = {
  enabled: true,
  rules: [
    {
      id: "c1275450-bc1f-40b7-b18e-c71436cb0a2c",
      type: "email",
      value: "admin@ai4ms.local",
      note: "管理员专用虚拟邮箱",
      enabled: true,
    },
    {
      id: "fddb22f5-4996-4343-85ce-6d246c75d655",
      type: "domain",
      value: "example.com",
      note: "示例域名，仅匹配本域",
      enabled: true,
    },
  ],
};

/** 为浏览器提供合成实例会话与有状态接口，禁止请求真实后端。 */
async function mockAPI(context) {
  const state = { policy: structuredClone(original), failSave: false, failLoad: false, checks: [], unexpected: [] };
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const response = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
        headers: { "access-control-allow-origin": new URL(baseURL).origin, "access-control-allow-credentials": "true" },
      });
    if (pathname === "/api/instances/")
      return response({
        instance: {
          id: "test-instance",
          instance_name: "邮件配置验收",
          is_setup_done: true,
          is_signup_screen_visited: true,
          workspaces_exist: true,
        },
        config: { enable_signup: false, is_smtp_configured: false },
      });
    if (pathname === "/api/instances/admins/me/")
      return response({
        id: "test-admin",
        email: "browser-admin@example.test",
        first_name: "测试管理员",
        display_name: "测试管理员",
        is_active: true,
      });
    if (pathname === "/api/instances/admins/") return response([{ user: "test-admin", role: 20 }]);
    if (pathname.includes("csrf-token")) return response({ csrf_token: "synthetic-test-csrf" });
    if (pathname === "/api/instances/configurations/") return response([{ key: "ENABLE_SMTP", value: "0" }]);
    if (pathname === "/api/instances/email-recipient-filters/") {
      if (request.method() === "GET") {
        if (state.failLoad) {
          return response({ error: "email_recipient_filters_unavailable" }, 503);
        }
        return response(state.policy);
      }
      if (request.method() === "PUT") {
        if (state.failSave) {
          state.failSave = false;
          return response({ error: "offline" }, 503);
        }
        state.policy = request.postDataJSON();
        return response(state.policy);
      }
    }
    if (pathname === "/api/instances/email-recipient-filters/check/") {
      const data = request.postDataJSON();
      state.checks.push(data);
      const targets = new Set();
      const issues = [];
      const rules = data.policy.rules.map((rule, index) => {
        const value = rule.value
          .trim()
          .toLowerCase()
          .replace(/^@/, "")
          .replace(/^.*<([^>]+)>$/, "$1");
        const target = `${rule.type}:${value}`;
        if (
          (rule.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ||
          (rule.type === "domain" && !/^[a-z\d.-]+$/.test(value))
        )
          issues.push({ index, message: "请输入有效的邮箱或域名。" });
        else if (targets.has(target)) issues.push({ index, message: "与已有规则重复。" });
        targets.add(target);
        return { ...rule, value };
      });
      if (issues.length) return response({ error: "invalid_email_recipient_filters", detail: { rules: issues } }, 400);
      const email = data.email
        .trim()
        .toLowerCase()
        .replace(/^.*<([^>]+)>$/, "$1");
      if (!email.includes("@")) return response({ detail: "请输入有效的邮箱地址。" }, 400);
      const matched =
        data.policy.enabled &&
        rules.find((rule) => rule.enabled && rule.value === (rule.type === "email" ? email : email.split("@")[1]));
      return response({ email, blocked: !!matched, matched_rule: matched || null });
    }
    state.unexpected.push(pathname);
    return response({ error: "unexpected_test_request" }, 418);
  });
  return state;
}

/** 验证页面自身及关键控件位于可见宽度内。 */
async function assertLayout(page) {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('main input, main select, main table, main h1, main [role="dialog"]')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width && (box.left < -1 || box.right > innerWidth + 1);
      })
      .map((element) => element.id || element.tagName),
  }));
  assert(layout.width <= layout.viewport, JSON.stringify(layout));
  assert.deepEqual(layout.overflow, [], JSON.stringify(layout));
}

/** 顺序验收桌面、手机、键盘、草稿保护及接口错误恢复。 */
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    colorScheme: "light",
  });
  const state = await mockAPI(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseURL}/email-filters/`);
    await page.getByRole("heading", { name: "邮箱过滤", exact: true }).waitFor();
    await page.getByRole("button", { name: "添加规则", exact: true }).waitFor();
    await assertLayout(page);
    await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
    const navigation = await page.locator('a[href$="/email/"], a[href$="/email-filters/"]').allTextContents();
    assert(navigation[0].includes("邮件服务") && navigation[1].includes("邮箱过滤"));
    await page.getByLabel("待检查邮箱").fill("user@example.com");
    await page.getByRole("button", { name: "检查规则", exact: true }).click();
    await page.getByText("将被屏蔽 · 命中域名规则：example.com").waitFor();
    await page.getByLabel("待检查邮箱").fill("user@sub.example.com");
    await page.getByRole("button", { name: "检查规则", exact: true }).click();
    await page.getByText("允许发送 · 未命中启用的规则").waitFor();
    await page.getByRole("button", { name: "添加规则", exact: true }).click();
    await page.getByLabel("批量添加").check();
    await page.getByLabel("批量目标地址", { exact: false }).fill("valid@example.org\ninvalid\nADMIN@AI4MS.LOCAL");
    await page.getByRole("button", { name: "加入草稿", exact: true }).click();
    await page.getByText("第 2 项 · invalid", { exact: false }).waitFor();
    await page.getByRole("button", { name: "仅添加 1 条有效规则" }).click();
    await page.locator("table").getByText("valid@example.org", { exact: true }).waitFor();
    state.failSave = true;
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await page.getByText("保存失败，草稿已保留，请重试。").waitFor();
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await page.getByText("已保存。下一次发送检查将使用新规则。").waitFor();
    assert.equal(state.policy.rules.length, 3);
    await page.getByRole("switch").first().click();
    await page.locator('a[href$="/email/"]').click();
    await page.getByRole("heading", { name: "有未保存的更改" }).waitFor();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    // 长目标在窄屏中换行，开关与编辑操作保持可达。
    state.policy.rules.push({
      id: "3d935bd8-3404-4bd7-bd68-65520754a200",
      type: "email",
      value: `${"long".repeat(14)}@${"domain".repeat(7)}.example.com`,
      note: "用于验证窄屏下长邮箱与说明文字的换行，操作入口不应被挤出屏幕。",
      enabled: true,
    });
    await page.reload();
    await page.getByRole("button", { name: "添加规则", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const sidebar = document.querySelector("div.inset-y-0");
      return !sidebar || sidebar.getBoundingClientRect().right <= 0;
    });
    await assertLayout(page);
    await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "添加规则", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByLabel("目标地址", { exact: false }).fill("keyboard@example.org");
    await page.keyboard.press("Tab");
    assert(await modal.evaluate((element) => element.contains(document.activeElement)), "弹窗 Tab 焦点丢失");
    await page.screenshot({ path: path.join(output, "mobile-modal.png"), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addStyleTag({ content: "html { filter: grayscale(1); }" });
    await page.screenshot({ path: path.join(output, "desktop-grayscale.png"), fullPage: true });
    state.failLoad = true;
    await page.reload();
    await page.getByText("无法读取邮箱过滤配置，请稍后重试。").waitFor();
    state.failLoad = false;
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await page.getByRole("button", { name: "添加规则", exact: true }).waitFor();
    assert.deepEqual(state.unexpected, []);
    assert.deepEqual(errors, []);
    const result = {
      passed: true,
      viewports: ["1440×1000", "390×844"],
      checks: state.checks.length,
      consoleErrors: errors,
      output,
    };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    process.stderr.write(
      JSON.stringify({
        url: page.url(),
        errors,
        unexpected: state.unexpected,
        text: await page.locator("body").innerText(),
      }) + "\n"
    );
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error) + "\n");
  process.exitCode = 1;
});
