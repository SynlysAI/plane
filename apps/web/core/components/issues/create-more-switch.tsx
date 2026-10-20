import { useId } from "react";
import { Switch } from "@makeplane/propel/components/switch";
import { useTranslation } from "@plane/i18n";

type CreateMoreSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  tabIndex?: number;
};

/** 为连续创建提供唯一的可访问名称和原生标签点击行为。 */
export function CreateMoreSwitch({ checked, onCheckedChange, tabIndex }: CreateMoreSwitchProps) {
  const id = useId();
  const { t } = useTranslation();

  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-1.5">
      <Switch
        id={id}
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
        tabIndex={tabIndex}
        nativeButton
        render={<button type="button" />}
      />
      <span className="text-caption-sm-regular">{t("create_more")}</span>
    </label>
  );
}
