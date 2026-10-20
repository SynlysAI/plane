/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// components
import { MemberDropdown } from "@/components/dropdowns/member/dropdown";
// hooks
import { useMember } from "@/hooks/store/use-member";

type Props = {
  value: any;
  onChange: (val: string | null) => void;
  isDisabled?: boolean;
};

export const MemberSelect = observer(function MemberSelect(props: Props) {
  const { value, onChange, isDisabled = false } = props;
  const { projectId } = useParams();
  const { t } = useTranslation();
  const {
    project: { getProjectMemberDetails },
  } = useMember();

  const selectedOption = projectId ? getProjectMemberDetails(value, projectId.toString()) : null;

  return (
    <MemberDropdown
      allowClear
      projectId={projectId?.toString()}
      value={selectedOption ? value : null}
      onChange={(lead) => onChange(lead === value || !lead ? null : lead)}
      multiple={false}
      buttonVariant="border-with-text"
      buttonClassName="!px-3 !py-2 bg-surface-1"
      placeholder={t("none")}
      disabled={isDisabled}
    />
  );
});
