import { useId } from "react";

import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";

type Props = {
  policy: "ADVISOR_ONLY" | "ALWAYS_PI" | "CONDITIONAL_PI";
  requiresPi: boolean;
  reviewerRole?: "ADVISOR" | "PI" | null;
  disabled?: boolean;
  returnDisabled?: boolean;
  onApprove: (escalateToPi: boolean) => Promise<void> | void;
  onReturn: () => Promise<void> | void;
};

/** Render the explicit review decision matrix shared by the stage panel and overview. */
export function ResearchChainStageReviewActions({
  policy,
  requiresPi,
  reviewerRole = null,
  disabled = false,
  returnDisabled = false,
  onApprove,
  onReturn,
}: Props) {
  const { t } = useTranslation();
  const conditionalHelpId = useId();
  const conditionalAllowed = policy === "CONDITIONAL_PI" && requiresPi;
  const showEscalation = reviewerRole !== "PI";

  return (
    <div className="flex flex-wrap gap-2">
      {policy === "ALWAYS_PI" && showEscalation ? (
        <Button variant="primary" size="sm" disabled={disabled} onClick={() => void onApprove(true)}>
          {t("research.chains.stage_approval.approve_to_pi")}
        </Button>
      ) : conditionalAllowed && showEscalation ? (
        <>
          <Button variant="primary" size="sm" disabled={disabled} onClick={() => void onApprove(true)}>
            {t("research.chains.stage_approval.approve_to_pi")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => void onApprove(false)}
            aria-describedby={conditionalHelpId}
          >
            {t("research.chains.stage_approval.approve_without_pi")}
          </Button>
        </>
      ) : (
        <Button variant="primary" size="sm" disabled={disabled} onClick={() => void onApprove(false)}>
          {policy === "CONDITIONAL_PI"
            ? t("research.chains.stage_approval.approve_without_pi")
            : t("research.chains.stage_approval.approve")}
        </Button>
      )}
      {policy === "CONDITIONAL_PI" && !requiresPi && showEscalation && (
        <Button
          variant="secondary"
          size="sm"
          disabled
          aria-describedby={conditionalHelpId}
          title={t("research.chains.stage_approval.escalation_not_declared")}
        >
          {t("research.chains.stage_approval.approve_to_pi")}
        </Button>
      )}
      <Button variant="secondary" size="sm" disabled={disabled || returnDisabled} onClick={() => void onReturn()}>
        {t("research.chains.stage_approval.return")}
      </Button>
      {policy === "CONDITIONAL_PI" && (
        <span id={conditionalHelpId} className="sr-only">
          {requiresPi
            ? t("research.chains.stage_approval.conditional_review_help")
            : t("research.chains.stage_approval.escalation_not_declared")}
        </span>
      )}
    </div>
  );
}
