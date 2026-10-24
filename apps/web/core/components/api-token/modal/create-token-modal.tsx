/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
// plane imports
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { APITokenService } from "@plane/services";
import type { IApiToken } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// constants
import { API_TOKENS_LIST } from "@plane/constants";
// local imports
import { CreateApiTokenForm } from "./form";
import { GeneratedTokenDetails } from "./generated-token-details";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

// services
const apiTokenService = new APITokenService();

export function CreateApiTokenModal(props: Props) {
  const { mutate } = useSWRConfig();
  const { isOpen, onClose } = props;
  // states
  const [neverExpires, setNeverExpires] = useState<boolean>(false);
  const [generatedToken, setGeneratedToken] = useState<IApiToken | null | undefined>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    if (!isOpen) {
      setGeneratedToken(null);
      setNeverExpires(false);
    }
    return () => {
      generation.current += 1;
    };
  }, [isOpen]);

  const handleClose = () => {
    generation.current += 1;
    setNeverExpires(false);
    setGeneratedToken(null);
    onClose();
  };

  const handleCreateToken = async (data: Partial<IApiToken>) => {
    const expected = generation.current;
    // make the request to generate the token
    await apiTokenService
      .create(data)
      .then((res) => {
        if (generation.current === expected) setGeneratedToken(res);
        // Only the read endpoint's metadata may enter the shared list cache.
        void mutate(API_TOKENS_LIST).catch(() => {
          /* The list displays refresh failures. */
        });
        return undefined;
      })
      .catch((err) => {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: "Error!",
          message: err.message || err.detail,
        });

        throw err;
      });
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={() => {}} position={EModalPosition.TOP} width={EModalWidth.XXL}>
      {generatedToken ? (
        <GeneratedTokenDetails handleClose={handleClose} tokenDetails={generatedToken} />
      ) : (
        <CreateApiTokenForm
          handleClose={handleClose}
          neverExpires={neverExpires}
          toggleNeverExpires={() => setNeverExpires((prevData) => !prevData)}
          onSubmit={handleCreateToken}
        />
      )}
    </ModalCore>
  );
}
