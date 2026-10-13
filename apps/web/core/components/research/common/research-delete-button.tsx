import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ModalCore } from "@plane/ui";
import { getResearchErrorKey } from "./error-messages";

type Props = {
  name: string;
  onDelete: () => Promise<void>;
  disabled?: boolean;
};

export function ResearchDeleteButton({ name, onDelete, disabled = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = t("research.deletion.delete_named", { name });
  const close = () => {
    if (!busy) setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-danger-subtle hover:text-danger-primary disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
      <ModalCore isOpen={open} handleClose={close}>
        <div className="mx-auto w-full max-w-md rounded-md bg-surface-1 p-5">
          <h3 className="text-16 font-semibold text-primary">{label}</h3>
          <p className="mt-3 text-13 break-words text-secondary">{t("research.deletion.confirm", { name })}</p>
          {error && (
            <p role="alert" className="mt-3 text-13 text-danger-primary">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={close}>
              {t("research.common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="!bg-danger-primary !text-on-color"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  await onDelete();
                  setOpen(false);
                } catch (failure) {
                  setError(t(getResearchErrorKey(failure)));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t("research.common.loading") : t("research.common.delete")}
            </Button>
          </div>
        </div>
      </ModalCore>
    </>
  );
}
