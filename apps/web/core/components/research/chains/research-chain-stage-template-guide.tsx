import { useTranslation } from "@plane/i18n";
import type { TReportTemplateSection } from "@plane/types";

type Props = {
  sections: TReportTemplateSection[];
};

/** Present the existing pre-opening template once above stage material rows. */
export function ResearchChainStageTemplateGuide({ sections }: Props) {
  const { t } = useTranslation();
  if (sections.length === 0) return null;

  return (
    <details className="mt-2 rounded-md border border-subtle bg-surface-1 px-3 py-2">
      <summary className="cursor-pointer list-none text-12 font-medium text-primary">
        {t("research.chains.stage_approval.template_guide_title")}
        <span className="font-normal mt-0.5 block text-11 text-tertiary">
          {t("research.chains.stage_approval.template_guide_summary", { count: sections.length })}
        </span>
      </summary>
      <ol className="mt-2 divide-y divide-subtle text-11" role="list">
        {sections.map((section) => (
          <li key={section.id} className="py-1.5 first:pt-0 last:pb-0">
            <p className="font-medium text-primary">
              {section.title}
              {section.max_chars ? ` · ${section.max_chars} ${t("research.chains.stage_approval.template_chars")}` : ""}
            </p>
            <p className="mt-0.5 text-secondary">{section.guidance}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
