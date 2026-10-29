import React from "react";
import { createRoot } from "react-dom/client";
import { Table } from "../../../../packages/ui/src/tables/table";
// oxlint-disable-next-line import/no-unassigned-import -- Load the app design tokens and responsive utilities.
import "../../styles/globals.css";

type MemberRow = {
  id: string;
  fullName: string;
  displayName: string;
  email: string;
  role: string;
  source: string;
  date: string;
};

const rows: MemberRow[] = [
  {
    id: "chinese-name",
    fullName: "科研测试用户长姓名场景用于检查列表内容是否被正确约束",
    displayName: "超长中文显示名称用于验证省略展示及完整内容提示",
    email: "long.chinese.member.name.for.overflow.check@example-laboratory.org",
    role: "管理员",
    source: "工作区与项目成员",
    date: "2026年10月29日",
  },
  {
    id: "latin-name",
    fullName: "Alexandria VeryLongResearcherFamilyNameAcrossMultipleWords",
    displayName: "Alexandria-Very-Long-Display-Name-For-Overflow-Testing",
    email: "alexandria.very-long-researcher-address-for-overflow@example-laboratory.org",
    role: "成员",
    source: "项目成员",
    date: "2026年10月29日",
  },
];

const columns = [
  {
    key: "full-name",
    content: "姓名",
    tdRender: (row: MemberRow) => (
      <div className="w-72 min-w-0 truncate" title={row.fullName}>
        {row.fullName}
      </div>
    ),
  },
  {
    key: "display-name",
    content: "显示名称",
    tdRender: (row: MemberRow) => (
      <div className="w-32 min-w-0 truncate" title={row.displayName}>
        {row.displayName}
      </div>
    ),
  },
  {
    key: "email",
    content: "邮箱",
    tdRender: (row: MemberRow) => (
      <div className="w-48 min-w-0 truncate" title={row.email}>
        {row.email}
      </div>
    ),
  },
  { key: "role", content: "角色", tdRender: (row: MemberRow) => <div className="w-24">{row.role}</div> },
  {
    key: "source",
    content: "成员来源",
    tdRender: (row: MemberRow) => <div className="max-w-40 break-words whitespace-normal">{row.source}</div>,
  },
  { key: "date", content: "加入日期", tdRender: (row: MemberRow) => <div className="w-28">{row.date}</div> },
  { key: "actions", content: "操作", tdRender: () => <button type="button">移除</button> },
];

function MemberTable({ label, minWidth }: { label: string; minWidth: string }) {
  return (
    <section className="mb-8 min-w-0">
      <h2 className="mb-3 text-14 font-semibold">{label}</h2>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        data-member-table-region
        className="min-w-0 overflow-x-auto overscroll-x-contain focus-visible:outline focus-visible:outline-1"
      >
        <div className="grid border-t border-subtle">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-subtle bg-surface-2 px-3 py-2">
            <span className="text-12 text-secondary">已选择 1 名成员</span>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button">取消选择</button>
              <button type="button">批量调整标签</button>
              <button type="button">账号配置</button>
            </div>
          </div>
          <Table
            columns={columns}
            data={rows}
            keyExtractor={(row) => row.id}
            tableClassName={minWidth}
            tHeadClassName="border-b border-subtle"
            thClassName="text-left font-medium text-placeholder"
            tBodyTrClassName="h-10 text-secondary"
          />
        </div>
      </div>
    </section>
  );
}

function MemberListOverflowFixture() {
  return (
    <main className="mx-auto w-full max-w-5xl min-w-0 p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-18 font-semibold">成员管理</h1>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <input aria-label="搜索成员" className="min-w-0 flex-1 basis-40 rounded-md border border-subtle px-2 py-1" />
          <button type="button" className="shrink-0 rounded-md border border-subtle px-2 py-1">
            添加成员
          </button>
        </div>
      </div>
      <MemberTable label="项目成员" minWidth="min-w-[64rem]" />
      <MemberTable label="工作区成员" minWidth="min-w-[80rem]" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<MemberListOverflowFixture />);
