"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { AddOutline, ChevronRightOutline, MoreHorizontalOutline } from "@makeplane/propel/icons";
import { Button } from "@plane/propel/button";
import { IconButton } from "@plane/propel/icon-button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { CustomMenu, EModalWidth, Input, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
import { collectBlockedIds, flattenCategories, projectHref } from "./research-project-tree.utils";
import useLocalStorage from "@/hooks/use-local-storage";
import {
  ResearchNavigationService,
  type TNavigationCategory,
  type TNavigationProject,
  type TNavigationScope,
  type TNavigationTree,
} from "@/services/research/navigation.service";

const service = new ResearchNavigationService();
const EMPTY_TREE: TNavigationTree = {
  scope: "RESEARCH",
  can_manage: false,
  categories: [],
  uncategorized: [],
};

type Props = { scope: TNavigationScope; title: string; href: string; canManage?: boolean };
type CategoryEditor =
  | { mode: "create"; name: string; parent: string | null; orgUnit: string | null }
  | { mode: "rename"; name: string; category: TNavigationCategory };
type DeleteEditor = { category: TNavigationCategory; target: string };
type MoveEditor = { project: TNavigationProject; currentCategory: string | null; target: string };
/** 从服务端错误中提取可读消息。 */
function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return "请稍后重试";
}

/** 渲染一个项目链接及其低干扰移动菜单。 */
function ProjectLink({
  project,
  currentCategoryId,
  canManage,
  onMove,
}: {
  project: TNavigationProject;
  currentCategoryId: string | null;
  canManage: boolean;
  onMove: (project: TNavigationProject, currentCategory: string | null) => void;
}) {
  const { workspaceSlug } = useParams();
  const pathname = usePathname();
  const href = projectHref(workspaceSlug, project);
  return (
    <SidebarNavItem isActive={pathname === href || pathname?.startsWith(`${href}/`)}>
      <Link href={href} className="min-w-0 flex-1 truncate" title={project.name}>
        <span className="block truncate text-12">{project.name}</span>
      </Link>
      {canManage && (
        <CustomMenu
          customButton={<MoreHorizontalOutline className="size-3" aria-hidden="true" />}
          customButtonClassName="grid place-items-center rounded-sm p-0.5"
          className="opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          placement="bottom-start"
          ariaLabel={`移动项目 ${project.name}`}
        >
          <CustomMenu.MenuItem onClick={() => onMove(project, currentCategoryId)}>移动到分类…</CustomMenu.MenuItem>
        </CustomMenu>
      )}
    </SidebarNavItem>
  );
}

/** 渲染一个分类/组别节点及其项目与子级。 */
function CategoryNode({
  category,
  expanded,
  toggleExpanded,
  categoryDepth = 1,
  siblings,
  canManage,
  onCreateChild,
  onRename,
  onSort,
  onDelete,
  onMoveProject,
}: {
  category: TNavigationCategory;
  expanded: Record<string, boolean>;
  toggleExpanded: (id: string) => void;
  categoryDepth?: number;
  siblings: TNavigationCategory[];
  canManage: boolean;
  onCreateChild: (parent: TNavigationCategory) => void;
  onRename: (category: TNavigationCategory) => void;
  onSort: (category: TNavigationCategory, direction: -1 | 1, neighbor: TNavigationCategory) => void;
  onDelete: (category: TNavigationCategory) => void;
  onMoveProject: (project: TNavigationProject, currentCategory: string | null) => void;
}) {
  const open = expanded[category.id] ?? true;
  const canAddChild = category.kind === "ORG" || categoryDepth < 3;
  const customSibling = siblings.filter((item) => item.kind === "CUSTOM");
  const customIndex = customSibling.findIndex((item) => item.id === category.id);

  return (
    <div className="flex flex-col">
      <div className="group flex items-center gap-1 rounded-sm px-2 py-1 text-12 text-tertiary hover:bg-layer-transparent-hover">
        <IconButton
          variant="ghost"
          size="sm"
          icon={ChevronRightOutline}
          iconClassName={cn("size-3 transition-transform", { "rotate-90": open })}
          aria-label={`${open ? "收起" : "展开"}${category.name}`}
          onClick={() => toggleExpanded(category.id)}
        />
        <span className="min-w-0 flex-1 truncate" title={category.name}>
          {category.name}
          {category.kind === "ORG" && <span className="ml-1 text-10 text-placeholder">组别</span>}
        </span>
        {canManage && (
          <CustomMenu
            customButton={<MoreHorizontalOutline className="size-3" aria-hidden="true" />}
            customButtonClassName="grid place-items-center rounded-sm p-0.5"
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            placement="bottom-start"
            ariaLabel={`管理分类 ${category.name}`}
          >
            {canAddChild && (
              <CustomMenu.MenuItem onClick={() => onCreateChild(category)}>新建子分类…</CustomMenu.MenuItem>
            )}
            {category.kind === "CUSTOM" && (
              <>
                <CustomMenu.MenuItem onClick={() => onRename(category)}>重命名…</CustomMenu.MenuItem>
                <CustomMenu.MenuItem
                  disabled={customIndex <= 0}
                  onClick={() => onSort(category, -1, customSibling[customIndex - 1])}
                >
                  上移
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem
                  disabled={customIndex < 0 || customIndex >= customSibling.length - 1}
                  onClick={() => onSort(category, 1, customSibling[customIndex + 1])}
                >
                  下移
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem onClick={() => onDelete(category)}>删除…</CustomMenu.MenuItem>
              </>
            )}
          </CustomMenu>
        )}
      </div>
      {open && (
        <div className="ml-3 border-l border-subtle pl-1" role="group" aria-label={category.name}>
          {category.children.map((child) => (
            <CategoryNode
              key={child.id}
              category={child}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              categoryDepth={category.kind === "ORG" ? 1 : categoryDepth + 1}
              siblings={category.children}
              canManage={canManage}
              onCreateChild={onCreateChild}
              onRename={onRename}
              onSort={onSort}
              onDelete={onDelete}
              onMoveProject={onMoveProject}
            />
          ))}
          {category.projects.map((project) => (
            <ProjectLink
              key={project.id}
              project={project}
              currentCategoryId={category.kind === "CUSTOM" ? category.id : null}
              canManage={canManage}
              onMove={onMoveProject}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 渲染一个项目通道的分类树和分类管理交互。 */
export function ResearchProjectTree({ scope, title, href, canManage = false }: Props) {
  const { workspaceSlug } = useParams();
  const [tree, setTree] = useState<TNavigationTree>({ ...EMPTY_TREE, scope });
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [categoryEditor, setCategoryEditor] = useState<CategoryEditor | null>(null);
  const [deleteEditor, setDeleteEditor] = useState<DeleteEditor | null>(null);
  const [moveEditor, setMoveEditor] = useState<MoveEditor | null>(null);
  const { storedValue: storedOpen, setValue: setStoredOpen } = useLocalStorage<boolean>(
    `research_navigation_${scope.toLowerCase()}_open`,
    true
  );
  const { storedValue: expanded, setValue: setExpandedValue } = useLocalStorage<Record<string, boolean>>(
    `research_nav_categories_${scope.toLowerCase()}`,
    {}
  );
  const isOpen = storedOpen ?? true;
  const canManageTree = canManage && tree.can_manage;

  /** 重新加载当前通道的分类树。 */
  const refreshTree = useCallback(async () => {
    if (!workspaceSlug) return;
    setIsLoading(true);
    setLoadFailed(false);
    try {
      setTree(await service.getTree(workspaceSlug.toString(), scope));
    } catch {
      setTree({ ...EMPTY_TREE, scope });
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, [scope, workspaceSlug]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  /** 切换分类节点的持久化展开状态。 */
  const toggleExpanded = useCallback(
    (id: string) => setExpandedValue({ ...expanded, [id]: !(expanded?.[id] ?? true) }),
    [expanded, setExpandedValue]
  );

  const flatCategories = useMemo(() => flattenCategories(tree.categories), [tree.categories]);

  /** 执行分类写操作并统一处理刷新与错误提示。 */
  const runMutation = useCallback(
    async (mutation: () => Promise<unknown>, successMessage: string) => {
      setIsMutating(true);
      try {
        await mutation();
        await refreshTree();
        setToast({ type: TOAST_TYPE.SUCCESS, title: "分类已更新", message: successMessage });
        return true;
      } catch (error) {
        setToast({ type: TOAST_TYPE.ERROR, title: "分类操作失败", message: errorMessage(error) });
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    [refreshTree]
  );

  /** 打开分类创建对话框，并识别组织锚点或自定义父级。 */
  const beginCreate = useCallback((parent: TNavigationCategory | null) => {
    const orgUnit = parent?.kind === "ORG" ? parent.id.slice("org:".length) : null;
    const parentCategory = parent?.kind === "CUSTOM" ? parent.id : null;
    setCategoryEditor({ mode: "create", name: "", parent: parentCategory, orgUnit });
  }, []);

  /** 提交分类创建或重命名。 */
  const submitCategoryEditor = async () => {
    if (!workspaceSlug || !categoryEditor) return;
    const name = categoryEditor.name.trim();
    if (!name) return;
    const succeeded =
      categoryEditor.mode === "create"
        ? await runMutation(
            () =>
              service.createCategory(workspaceSlug.toString(), {
                scope,
                name,
                parent: categoryEditor.parent,
                org_unit: categoryEditor.orgUnit,
              }),
            "已创建分类。"
          )
        : await runMutation(
            () =>
              service.updateCategory(workspaceSlug.toString(), categoryEditor.category.id, {
                name,
              }),
            "已保存分类名称。"
          );
    if (succeeded) setCategoryEditor(null);
  };

  /** 提交分类排序变更。 */
  const sortCategory = async (category: TNavigationCategory, direction: -1 | 1, neighbor: TNavigationCategory) => {
    if (!workspaceSlug || !neighbor) return;
    const nextOrder = neighbor.sort_order + (direction === -1 ? -0.001 : 0.001);
    await runMutation(
      () => service.updateCategory(workspaceSlug.toString(), category.id, { sort_order: nextOrder }),
      "已调整分类顺序。"
    );
  };

  /** 提交显式迁移后的分类删除。 */
  const submitDelete = async () => {
    if (!workspaceSlug || !deleteEditor) return;
    const succeeded = await runMutation(
      () =>
        service.deleteCategory(
          workspaceSlug.toString(),
          deleteEditor.category.id,
          deleteEditor.target || "uncategorized"
        ),
      "分类内项目与子分类已按选择保留。"
    );
    if (succeeded) setDeleteEditor(null);
  };

  /** 提交项目移动，仅更新导航关联。 */
  const submitMove = async () => {
    if (!workspaceSlug || !moveEditor) return;
    const target = moveEditor.target || null;
    const succeeded = await runMutation(
      () => service.moveProject(workspaceSlug.toString(), moveEditor.project.id, scope, target),
      "项目已移动，成员和权限保持不变。"
    );
    if (succeeded) setMoveEditor(null);
  };

  const deleteTargets = useMemo(() => {
    if (!deleteEditor) return [];
    const blocked = collectBlockedIds(deleteEditor.category);
    return flatCategories.filter((item) => !blocked.has(item.category.id));
  }, [deleteEditor, flatCategories]);

  const moveTargets = useMemo(() => {
    if (!moveEditor) return [];
    return flatCategories.filter((item) => item.category.id !== moveEditor.currentCategory);
  }, [flatCategories, moveEditor]);

  if (!workspaceSlug) return null;

  return (
    <div className="mt-2 flex flex-col border-t border-subtle pt-2">
      <div className="group flex items-center gap-1 rounded-sm px-2 py-1.5 text-placeholder hover:bg-layer-transparent-hover">
        <IconButton
          variant="ghost"
          size="sm"
          icon={ChevronRightOutline}
          iconClassName={cn("size-3 transition-transform", { "rotate-90": isOpen })}
          aria-label={`${isOpen ? "收起" : "展开"}${title}`}
          onClick={() => setStoredOpen(!isOpen)}
        />
        <Link href={href} className="min-w-0 flex-1 truncate text-13 font-semibold">
          {title}
        </Link>
        {canManageTree && (
          <IconButton
            variant="ghost"
            size="sm"
            icon={AddOutline}
            aria-label={`新建${title}分类`}
            onClick={() => beginCreate(null)}
          />
        )}
      </div>

      {isOpen && (
        <div className="flex max-h-72 flex-col overflow-x-hidden overflow-y-auto pl-2">
          {isLoading && <span className="px-2 py-1 text-11 text-placeholder">正在加载项目…</span>}
          {!isLoading && loadFailed && (
            <span className="px-2 py-1 text-11 text-placeholder">分类暂不可用，可稍后刷新。</span>
          )}
          {!isLoading && !loadFailed && tree.categories.length === 0 && tree.uncategorized.length === 0 && (
            <span className="px-2 py-1 text-11 text-placeholder">暂无可见项目。</span>
          )}
          {tree.categories.map((category) => (
            <CategoryNode
              key={category.id}
              category={category}
              expanded={expanded ?? {}}
              toggleExpanded={toggleExpanded}
              siblings={tree.categories}
              canManage={canManageTree}
              onCreateChild={beginCreate}
              onRename={(item) => setCategoryEditor({ mode: "rename", name: item.name, category: item })}
              onSort={sortCategory}
              onDelete={(item) => setDeleteEditor({ category: item, target: "uncategorized" })}
              onMoveProject={(project, currentCategory) =>
                setMoveEditor({ project, currentCategory, target: currentCategory ?? "uncategorized" })
              }
            />
          ))}
          {!isLoading && (tree.uncategorized.length > 0 || canManageTree) && (
            <div className="mt-1 border-t border-subtle pt-1">
              <span className="px-2 text-11 text-tertiary">未分类</span>
              {tree.uncategorized.map((project) => (
                <ProjectLink
                  key={project.id}
                  project={project}
                  currentCategoryId={null}
                  canManage={canManageTree}
                  onMove={(item, currentCategory) =>
                    setMoveEditor({
                      project: item,
                      currentCategory,
                      target: currentCategory ?? "uncategorized",
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ModalCore
        isOpen={categoryEditor !== null}
        handleClose={() => !isMutating && setCategoryEditor(null)}
        width={EModalWidth.SM}
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCategoryEditor();
          }}
        >
          <h3 className="text-15 font-semibold">{categoryEditor?.mode === "rename" ? "重命名分类" : "新建分类"}</h3>
          <p className="mt-1 text-12 text-secondary">分类只影响侧边栏组织，不改变项目成员或权限。</p>
          <label htmlFor="navigation-category-name" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            分类名称
            <Input
              id="navigation-category-name"
              value={categoryEditor?.name ?? ""}
              maxLength={255}
              onChange={(event) =>
                setCategoryEditor((current) => (current ? { ...current, name: event.target.value } : current))
              }
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isMutating}
              onClick={() => setCategoryEditor(null)}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={isMutating}>
              保存
            </Button>
          </div>
        </form>
      </ModalCore>

      <ModalCore
        isOpen={deleteEditor !== null}
        handleClose={() => !isMutating && setDeleteEditor(null)}
        width={EModalWidth.SM}
      >
        <div className="p-5">
          <h3 className="text-15 font-semibold">删除分类</h3>
          <p className="mt-1 text-12 text-secondary">
            项目不会被删除。请选择项目迁移位置；子分类会移到所选分类，选择“未分类”时子分类会上移一级。
          </p>
          <label htmlFor="navigation-delete-target" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            项目移动到
            <select
              id="navigation-delete-target"
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={deleteEditor?.target ?? "uncategorized"}
              onChange={(event) =>
                setDeleteEditor((current) => (current ? { ...current, target: event.target.value } : current))
              }
            >
              <option value="uncategorized">未分类</option>
              {deleteTargets.map(({ category, depth }) => (
                <option key={category.id} value={category.id}>
                  {`${"— ".repeat(depth)}${category.name}`}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={isMutating} onClick={() => setDeleteEditor(null)}>
              取消
            </Button>
            <Button variant="error-fill" size="sm" loading={isMutating} onClick={() => void submitDelete()}>
              删除分类
            </Button>
          </div>
        </div>
      </ModalCore>

      <ModalCore
        isOpen={moveEditor !== null}
        handleClose={() => !isMutating && setMoveEditor(null)}
        width={EModalWidth.SM}
      >
        <div className="p-5">
          <h3 className="text-15 font-semibold">移动项目</h3>
          <p className="mt-1 truncate text-12 text-secondary" title={moveEditor?.project.name}>
            {moveEditor?.project.name}
          </p>
          <label htmlFor="navigation-move-target" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            目标分类
            <select
              id="navigation-move-target"
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={moveEditor?.target ?? "uncategorized"}
              onChange={(event) =>
                setMoveEditor((current) => (current ? { ...current, target: event.target.value } : current))
              }
            >
              <option value="uncategorized">未分类</option>
              {moveTargets.map(({ category, depth }) => (
                <option key={category.id} value={category.id}>
                  {`${"— ".repeat(depth)}${category.name}`}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={isMutating} onClick={() => setMoveEditor(null)}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={isMutating} onClick={() => void submitMove()}>
              移动项目
            </Button>
          </div>
        </div>
      </ModalCore>
    </div>
  );
}
