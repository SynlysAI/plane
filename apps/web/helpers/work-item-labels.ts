import { STATE_GROUPS } from "@plane/constants";
import type { TTranslationStore } from "@plane/i18n";
import type { IState } from "@plane/types";

/** 翻译内置工作流名称，保留项目自定义状态名称和原始数据。
 * @param state 工作流状态的名称与分组。
 * @param t 当前界面使用的翻译函数。
 * @returns 当前语言下的状态名称。
 */
export function getStateDisplayName(state: Pick<IState, "name" | "group">, t: TTranslationStore["t"]): string {
  const isBuiltIn = state.name === STATE_GROUPS[state.group]?.defaultStateName;
  return isBuiltIn ? t(`workspace_projects.state.${state.group}`, { defaultValue: state.name }) : state.name;
}
