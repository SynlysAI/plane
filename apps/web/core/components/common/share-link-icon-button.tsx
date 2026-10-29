"use client";

import { useCallback } from "react";
import { LinkOutline } from "@makeplane/propel/icons";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { useTranslation } from "@plane/i18n";
import { IconButton } from "@plane/propel/icon-button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { copyTextToClipboard } from "@plane/utils";
import { usePlatformOS } from "@/hooks/use-platform-os";
import { formatShareText } from "./share-link";

type Props = {
  /** 分享文本中的对象类型，例如“行政工作项”。 */
  typeLabel: string;
  /** 分享文本中的对象标题。 */
  title: string;
  /** 应用内相对链接或完整链接。 */
  href: string;
  /** 图标按钮的可访问名称。 */
  ariaLabel: string;
  /** 悬停提示；缺省时使用可访问名称。 */
  tooltipLabel?: string;
  /** 追加到图标按钮上的样式。 */
  className?: string;
};

/**
 * 复制带类型、标题与绝对链接的分享文本，并渲染统一的链接图标按钮。
 *
 * Args:
 *   typeLabel: 已本地化的对象类型。
 *   title: 分享对象标题。
 *   href: 应用路由或完整链接。
 *   ariaLabel: 图标按钮的可访问名称。
 *   tooltipLabel: 可选悬停提示文案。
 *   className: 可选按钮样式。
 */
export function ShareLinkIconButton({ typeLabel, title, href, ariaLabel, tooltipLabel, className }: Props) {
  const { t } = useTranslation();
  const { isMobile } = usePlatformOS();

  const handleCopyLink = useCallback(async () => {
    try {
      await copyTextToClipboard(formatShareText(typeLabel, title, href));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.common.share_copied_title"),
        message: t("research.common.share_copied_message"),
      });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("research.common.share_copy_failed_title"),
        message: t("research.common.share_copy_failed_message"),
      });
    }
  }, [href, t, title, typeLabel]);

  return (
    <Tooltip label={tooltipLabel ?? ariaLabel} disabled={isMobile}>
      <IconButton
        variant="secondary"
        size="lg"
        className={className}
        aria-label={ariaLabel}
        onClick={() => void handleCopyLink()}
        icon={LinkOutline}
      />
    </Tooltip>
  );
}
