import { useEffect, useId, useRef, useState } from "react";
import { observer } from "mobx-react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { DEFAULT_CONTENT_BACKGROUND_OPACITY, getContentBackgroundOpacity } from "@/helpers/workspace-backgrounds";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useUserProfile } from "@/hooks/store/user";

/** 预览内容底色透明度，并在一次指针或键盘交互完成后保存最终值。 */
export const BackgroundOpacityControl = observer(function BackgroundOpacityControl({
  disabled,
}: {
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { data: profile, updateUserTheme } = useUserProfile();
  const { contentBackgroundOpacityPreview, setContentBackgroundOpacityPreview } = useAppTheme();
  const id = useId();
  const savedOpacity = getContentBackgroundOpacity(profile?.theme?.contentBackgroundOpacity);
  const opacity = contentBackgroundOpacityPreview ?? savedOpacity;
  const transparency = Math.round((1 - opacity) * 100);
  const [isSaving, setIsSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draft = useRef(savedOpacity);
  const dirty = useRef(false);
  const pointerActive = useRef(false);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      setContentBackgroundOpacityPreview(undefined);
    };
  }, [setContentBackgroundOpacityPreview]);

  useEffect(() => {
    if (disabled) {
      clearTimeout(timer.current);
      dirty.current = false;
      pointerActive.current = false;
      setContentBackgroundOpacityPreview(undefined);
    }
  }, [disabled, setContentBackgroundOpacityPreview]);

  /** 合并保存最终值，去重松手、失焦与延迟提交；失败时恢复账号偏好。 */
  const commit = async () => {
    clearTimeout(timer.current);
    pointerActive.current = false;
    if (!dirty.current || saving.current || disabled) return;
    dirty.current = false;
    if (draft.current === savedOpacity) {
      setContentBackgroundOpacityPreview(undefined);
      return;
    }
    saving.current = true;
    setIsSaving(true);
    try {
      await updateUserTheme({ contentBackgroundOpacity: draft.current });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("failed_to_update_workspace_background_opacity"),
      });
    } finally {
      saving.current = false;
      if (mounted.current) {
        setIsSaving(false);
        setContentBackgroundOpacityPreview(undefined);
      }
    }
  };

  /** 更新临时预览；键盘交互在空闲 300 毫秒后提交。 */
  const preview = (value: number) => {
    if (disabled || saving.current) return;
    draft.current = value;
    dirty.current = true;
    setContentBackgroundOpacityPreview(value);
    clearTimeout(timer.current);
    if (!pointerActive.current) timer.current = setTimeout(() => void commit(), 300);
  };

  return (
    <div className="mt-4 border-t border-subtle pt-3" aria-busy={isSaving}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-body-sm-medium text-primary">
          {t("workspace_background_transparency")}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <output htmlFor={id} className="w-12 text-right text-body-sm-regular text-secondary tabular-nums">
            {transparency}%
          </output>
          <Tooltip tooltipContent={t("workspace_background_opacity_reset")}>
            <button
              type="button"
              aria-label={t("workspace_background_opacity_reset")}
              disabled={disabled || isSaving || opacity === DEFAULT_CONTENT_BACKGROUND_OPACITY}
              className="grid size-8 place-items-center rounded-md text-secondary hover:bg-layer-1-hover focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                preview(DEFAULT_CONTENT_BACKGROUND_OPACITY);
                void commit();
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={transparency}
        aria-valuetext={`${transparency}%`}
        disabled={disabled || isSaving}
        className="h-8 w-full cursor-pointer accent-[var(--bg-accent-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        onChange={(event) => preview((100 - Number(event.target.value)) / 100)}
        onPointerDown={(event) => {
          pointerActive.current = true;
          clearTimeout(timer.current);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => {
          pointerActive.current = false;
          void commit();
        }}
        onPointerCancel={() => {
          pointerActive.current = false;
          dirty.current = false;
          clearTimeout(timer.current);
          setContentBackgroundOpacityPreview(undefined);
        }}
        onBlur={() => void commit()}
      />
    </div>
  );
});
