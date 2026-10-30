/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useTranslation } from "@plane/i18n";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { WarningTriangleOutline } from "@makeplane/propel/icons";
// types
import { Button } from "@plane/propel/button";
import type { IUserLite } from "@plane/types";
// ui
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { useUser } from "@/hooks/store/user";

type Props = {
  data: Partial<IUserLite>;
  onSubmit: () => Promise<void>;
  isOpen: boolean;
  onClose: () => void;
  isInheritedOnly?: boolean;
};

export const ConfirmProjectMemberRemove = observer(function ConfirmProjectMemberRemove(props: Props) {
  const { data, onSubmit, isOpen, onClose, isInheritedOnly = false } = props;
  const { t } = useTranslation();
  // router
  const { projectId } = useParams();
  // states
  const [isDeleteLoading, setIsDeleteLoading] = useState(false);
  // store hooks
  const { data: currentUser } = useUser();
  const { getProjectById } = useProject();

  const handleClose = () => {
    onClose();
    setIsDeleteLoading(false);
  };

  const handleDeletion = async () => {
    setIsDeleteLoading(true);

    await onSubmit();

    handleClose();
  };

  if (!projectId) return <></>;

  const isCurrentUser = currentUser?.id === data?.id;
  const currentProjectDetails = getProjectById(projectId.toString());

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <div className="bg-surface-1 px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
        <div className="sm:flex sm:items-start">
          <div className="mx-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-danger-subtle sm:mx-0 sm:h-10 sm:w-10">
            <WarningTriangleOutline className="h-6 w-6 text-danger-primary" aria-hidden="true" />
          </div>
          <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
            <h3 className="text-16 leading-6 font-medium text-primary">
              {isCurrentUser
                ? t("project_settings.members.confirm_leave_title")
                : t("project_settings.members.confirm_remove_title", { name: data?.display_name ?? "" })}
            </h3>
            <div className="mt-2">
              <p className="text-13 text-secondary">
                {isCurrentUser ? (
                  <>
                    {t("project_settings.members.confirm_leave_description", {
                      project: currentProjectDetails?.name ?? "",
                    })}
                  </>
                ) : isInheritedOnly ? (
                  <>
                    {t("project_settings.members.confirm_revoke_description", {
                      name: data?.display_name ?? "",
                    })}
                  </>
                ) : (
                  <>{t("project_settings.members.confirm_remove_description", { name: data?.display_name ?? "" })}</>
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 p-4 sm:px-6">
        <Button variant="secondary" size="lg" onClick={handleClose}>
          {t("cancel")}
        </Button>
        <Button variant="error-fill" size="lg" onClick={handleDeletion} loading={isDeleteLoading}>
          {isCurrentUser
            ? isDeleteLoading
              ? t("project_settings.members.leaving")
              : t("leave")
            : isDeleteLoading
              ? t("project_settings.members.removing")
              : t("remove")}
        </Button>
      </div>
    </ModalCore>
  );
});
