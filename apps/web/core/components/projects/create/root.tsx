/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { FormProvider, useForm } from "react-hook-form";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EFileAssetType } from "@plane/types";
// components
import ProjectCommonAttributes from "@/components/project/create/common-attributes";
import ProjectCreateHeader from "@/components/project/create/header";
import ProjectCreateButtons from "@/components/project/create/project-create-buttons";
// hooks
import { getCoverImageType, uploadCoverImage } from "../../../../helpers/cover-image.helper";
import { useProject } from "@/hooks/store/use-project";
import { usePlatformOS } from "@/hooks/use-platform-os";
// plane web types
import type { TProject } from "@plane/types";
import { ProjectAttributes } from "./attributes";
import { getProjectFormValues } from "./utils";
import { useResearch } from "@/hooks/store/use-research";
import { ResearchNavigationService, type TAdministrativeOrganization } from "@/services/research/navigation.service";

const navigationService = new ResearchNavigationService();

export type TCreateProjectFormProps = {
  setToFavorite?: boolean;
  workspaceSlug: string;
  onClose: () => void;
  handleNextStep: (projectId: string) => void;
  data?: Partial<TProject>;
  templateId?: string;
  updateCoverImageStatus: (projectId: string, coverImage: string) => Promise<void>;
  administrative?: boolean;
};

export const CreateProjectForm = observer(function CreateProjectForm(props: TCreateProjectFormProps) {
  const {
    setToFavorite,
    workspaceSlug,
    data,
    onClose,
    handleNextStep,
    updateCoverImageStatus,
    administrative = false,
  } = props;
  // store
  const { t } = useTranslation();
  const { addProjectToFavorites, createProject, updateProject } = useProject();
  const research = useResearch();
  // states
  const [shouldAutoSyncIdentifier, setShouldAutoSyncIdentifier] = useState(true);
  const [organizations, setOrganizations] = useState<TAdministrativeOrganization[]>([]);
  const [organizationChoice, setOrganizationChoice] = useState("");
  const [newOrganizationName, setNewOrganizationName] = useState("");
  const [organizationsLoaded, setOrganizationsLoaded] = useState(false);
  const [organizationLoadFailed, setOrganizationLoadFailed] = useState(false);
  // form info
  const methods = useForm<TProject>({
    defaultValues: { ...getProjectFormValues(), ...data },
    reValidateMode: "onChange",
  });
  const { handleSubmit, reset, setValue } = methods;
  const { isMobile } = usePlatformOS();

  useEffect(() => {
    if (!administrative) return;
    setOrganizations([]);
    setOrganizationChoice("");
    setOrganizationsLoaded(false);
    setOrganizationLoadFailed(false);
    void navigationService
      .getAdministrativeOrganizations(workspaceSlug)
      .then((items) => {
        setOrganizations(items);
        setOrganizationChoice(items.find((item) => item.is_default)?.id ?? "");
        return undefined;
      })
      .catch(() => setOrganizationLoadFailed(true))
      .finally(() => setOrganizationsLoaded(true));
  }, [administrative, workspaceSlug]);
  const handleAddToFavorites = (projectId: string) => {
    if (!workspaceSlug) return;

    addProjectToFavorites(workspaceSlug.toString(), projectId).catch(() => {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("toast.error"),
        message: t("failed_to_remove_project_from_favorites"),
      });
    });
  };

  const onSubmit = async (formData: Partial<TProject>) => {
    // Upper case identifier
    formData.identifier = formData.identifier?.toUpperCase();
    const coverImage = formData.cover_image_url;
    let uploadedAssetUrl: string | null = null;

    if (coverImage) {
      const imageType = getCoverImageType(coverImage);

      if (imageType === "local_static") {
        try {
          uploadedAssetUrl = await uploadCoverImage(coverImage, {
            workspaceSlug: workspaceSlug.toString(),
            entityIdentifier: "",
            entityType: EFileAssetType.PROJECT_COVER,
            isUserAsset: false,
          });
        } catch (error) {
          console.error("Error uploading cover image:", error);
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("toast.error"),
            message: error instanceof Error ? error.message : "Failed to upload cover image",
          });
          return Promise.reject(error);
        }
      } else {
        formData.cover_image = coverImage;
        formData.cover_image_asset = null;
      }
    }

    if (administrative && organizationChoice === "new") {
      formData.new_administrative_organization = newOrganizationName.trim();
    } else if (administrative) {
      formData.administrative_organization = organizationChoice;
    }
    return createProject(workspaceSlug.toString(), formData)
      .then(async (res) => {
        if (uploadedAssetUrl) {
          await updateCoverImageStatus(res.id, uploadedAssetUrl);
          await updateProject(workspaceSlug.toString(), res.id, { cover_image_url: uploadedAssetUrl });
        } else if (coverImage && coverImage.startsWith("http")) {
          await updateCoverImageStatus(res.id, coverImage);
          await updateProject(workspaceSlug.toString(), res.id, { cover_image_url: coverImage });
        }
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("success"),
          message: t("project_created_successfully"),
        });

        if (setToFavorite) {
          handleAddToFavorites(res.id);
        }
        return handleNextStep(res.id);
      })
      .catch((err) => {
        try {
          // Handle the new error format where codes are nested in arrays under field names
          const errorData = err?.data ?? {};

          const nameError = errorData.name?.includes("PROJECT_NAME_ALREADY_EXIST");
          const identifierError = errorData?.identifier?.includes("PROJECT_IDENTIFIER_ALREADY_EXIST");
          const nameSpecialCharError = errorData?.name?.includes("PROJECT_NAME_CANNOT_CONTAIN_SPECIAL_CHARACTERS");

          if (nameError || identifierError || nameSpecialCharError) {
            if (nameError) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("toast.error"),
                message: t("project_name_already_taken"),
              });
            }

            if (identifierError) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("toast.error"),
                message: t("project_identifier_already_taken"),
              });
            }

            if (nameSpecialCharError) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("toast.error"),
                message: t("project_name_cannot_contain_special_characters"),
              });
            }
          } else {
            setToast({
              type: TOAST_TYPE.ERROR,
              title: t("toast.error"),
              message: t("something_went_wrong"),
            });
          }
        } catch (error) {
          // Fallback error handling if the error processing fails
          console.error("Error processing API error:", error);
          setToast({
            type: TOAST_TYPE.ERROR,
            title: t("toast.error"),
            message: t("something_went_wrong"),
          });
        }
      });
  };

  const handleClose = () => {
    onClose();
    setShouldAutoSyncIdentifier(true);
    setTimeout(() => {
      reset();
    }, 300);
  };

  return (
    <FormProvider {...methods}>
      <ProjectCreateHeader handleClose={handleClose} isMobile={isMobile} />

      <form onSubmit={handleSubmit(onSubmit)} className="px-3">
        <div className="mt-9 space-y-6 pb-5">
          <ProjectCommonAttributes
            setValue={setValue}
            isMobile={isMobile}
            shouldAutoSyncIdentifier={shouldAutoSyncIdentifier}
            setShouldAutoSyncIdentifier={setShouldAutoSyncIdentifier}
          />
          {administrative && (
            <div className="grid max-w-xl grid-cols-1 gap-2 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-12 text-secondary">
                行政组织
                <select
                  id="administrative-organization"
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-2 text-13 text-primary"
                  value={organizationChoice}
                  onChange={(event) => setOrganizationChoice(event.target.value)}
                  disabled={!organizationsLoaded || organizationLoadFailed}
                  required
                >
                  {organizations
                    .filter((organization) => !organization.is_default)
                    .map((organization) => (
                      <option key={organization.id} value={organization.id} disabled={!organization.can_manage}>
                        {organization.name}
                        {organization.can_manage ? "" : "（需组织管理员权限）"}
                      </option>
                    ))}
                  {organizations
                    .filter((organization) => organization.is_default)
                    .map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name || "公共"}
                      </option>
                    ))}
                  {research.isWorkspaceAdmin && <option value="new">＋ 新建组织</option>}
                </select>
                {organizationLoadFailed && <span className="text-12 text-secondary">组织加载失败，请稍后重试。</span>}
              </label>
              {organizationChoice === "new" && (
                <label className="flex flex-col gap-1 text-12 text-secondary">
                  新组织名称
                  <input
                    id="new-administrative-organization"
                    className="rounded-md border border-subtle bg-surface-1 px-2 py-2 text-13 text-primary"
                    value={newOrganizationName}
                    maxLength={255}
                    onChange={(event) => setNewOrganizationName(event.target.value)}
                    required
                  />
                </label>
              )}
            </div>
          )}
          <ProjectAttributes isMobile={isMobile} />
        </div>
        <ProjectCreateButtons
          handleClose={handleClose}
          disabled={administrative && (!organizationsLoaded || organizationLoadFailed || !organizationChoice)}
        />
      </form>
    </FormProvider>
  );
});
