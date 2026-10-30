import axios from "axios";
import type { UnifiedConnection, UnifiedIssued } from "@/services/unified-mcp.service";
import type { WeeklyReportConnection, WeeklyReportIssued } from "@/services/weekly-report-mcp.service";

const lifetimes = [1, 7, 30, 365, null];
const workspace = { id: "11111111-2222-4333-8444-555555555555", slug: "lab", name: "材料科学研究工作区" };
const common = {
  created_at: "2026-10-30T02:00:00Z",
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  configuration_available: true,
};
const seed: UnifiedConnection[] = [
  {
    ...common,
    id: "21111111-2222-4333-8444-555555555555",
    name: "科研与行政协作",
    scope: {
      include_future_objects: true,
      workspaces: [
        {
          workspace_id: workspace.id,
          workspace_name: workspace.name,
          domains: { administrative: "read_write", research: "read" },
        },
      ],
    },
    implemented_capabilities: ["read", "administrative_write"],
  },
  {
    ...common,
    id: "31111111-2222-4333-8444-555555555555",
    name: "历史连接_" + "LongConnectionName".repeat(5),
    scope: {
      include_future_objects: false,
      workspaces: [{ workspace_id: workspace.id, workspace_name: workspace.name, domains: { research: "read" } }],
    },
    implemented_capabilities: ["read"],
    configuration_available: false,
  },
];
const storageKey = "mcp-settings-fixture-metadata";
const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
let projects: UnifiedConnection[] = saved?.projects ?? seed;
let weekly: WeeklyReportConnection[] = saved?.weekly ?? [
  {
    ...common,
    id: "41111111-2222-4333-8444-555555555555",
    workspace: workspace.slug,
    label: "每周科研进展",
    actions: ["save_draft", "submit"],
    report_type: "WEEKLY",
    period_policy: "current_and_previous_week.v1",
  },
];
const counters = { creates: 0, configurations: 0, rotations: 0 };
Object.assign(window, { mcpFixture: counters });

/** 只持久化合成元数据，刷新验收时不保存完整配置或密钥。 */
function persist() {
  localStorage.setItem(storageKey, JSON.stringify({ projects, weekly }));
}

/** 生成仅在隔离页面中有效的合成客户端配置。 */
function configuration(row: UnifiedConnection | WeeklyReportConnection): UnifiedIssued | WeeklyReportIssued {
  const raw = row.id.replaceAll("-", "").padEnd(43, "a");
  if ("name" in row) {
    const url = `${location.origin}/api/mcp/`;
    const secret = `pum_${raw}`;
    return {
      ...row,
      secret,
      mcp_url: url,
      codex_toml: "",
      sciencediscovery_json: JSON.stringify({
        mcpServers: { plane: { type: "http", url, headers: { Authorization: `Bearer ${secret}` } } },
      }),
    };
  }
  return {
    ...row,
    mcp_path: `/api/research/workspaces/${workspace.slug}/weekly-report-agent/mcp/`,
    headers: { "X-Weekly-Report-Token": `pwr_${raw}` },
    csrf_token: "fixture-csrf",
  };
}

// 在业务组件创建 axios 实例之前安装适配器，所有请求都留在隔离页面内。
axios.defaults.adapter = async (config) => {
  const path = new URL(config.url!, location.origin).pathname;
  const isWeekly = path.includes("weekly-report/");
  const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
  let data: unknown;
  if (path.endsWith("/options/")) {
    data = isWeekly
      ? {
          identity: { user_id: "fixture-profile", display_name: "验收用户" },
          workspaces: [
            {
              ...workspace,
              enabled: true,
              unavailable_reason: null,
              actions: ["save_draft", "submit"],
              ttl_days: lifetimes,
              default_ttl_days: 365,
              period_policy: "current_and_previous_week.v1",
              period_description: "仅本人本周与上周的周报，周期按工作区报告时区计算。",
            },
          ],
        }
      : {
          results: [
            { ...workspace, domains: { administrative: ["read", "read_write"], research: ["read", "read_write"] } },
          ],
          next_cursor: null,
          csrf_token: "fixture-csrf",
          ttl_days: lifetimes,
          default_ttl_days: 365,
          max_workspaces: 20,
        };
  } else if (path.endsWith("/connections/") && config.method === "get") {
    data = { results: isWeekly ? weekly : projects, next_cursor: null, csrf_token: "fixture-csrf" };
  } else if (path.endsWith("/connections/")) {
    counters.creates += 1;
    const created = {
      ...common,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      expires_at: body.ttl_days === null ? null : new Date(Date.now() + body.ttl_days * 86_400_000).toISOString(),
    };
    if (isWeekly) {
      const row: WeeklyReportConnection = {
        ...created,
        workspace: workspace.slug,
        label: body.label,
        actions: body.actions,
        report_type: "WEEKLY",
        period_policy: "current_and_previous_week.v1",
      };
      weekly = [row, ...weekly];
      data = configuration(row);
    } else {
      const row: UnifiedConnection = {
        ...created,
        name: body.name,
        implemented_capabilities: ["read"],
        scope: {
          include_future_objects: body.include_future_objects,
          workspaces: body.workspaces.map((entry: UnifiedConnection["scope"]["workspaces"][number]) =>
            Object.assign({}, entry, { workspace_name: workspace.name })
          ),
        },
      };
      projects = [row, ...projects];
      data = configuration(row);
    }
    persist();
  } else {
    const id = path.split("/").at(-3);
    const row = (isWeekly ? weekly : projects).find((item) => item.id === id)!;
    if (path.endsWith("/revoke/")) {
      row.revoked_at = new Date().toISOString();
      row.configuration_available = false;
      data = { revoked: true };
    } else {
      if (path.endsWith("/rotate/")) {
        counters.rotations += 1;
        row.configuration_available = true;
      } else counters.configurations += 1;
      data = configuration(row);
    }
    persist();
  }
  return { data, status: 200, statusText: "OK", headers: {}, config };
};
