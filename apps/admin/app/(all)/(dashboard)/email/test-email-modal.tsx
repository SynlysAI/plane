/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState, Fragment } from "react";
import { Dialog, Transition } from "@headlessui/react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { Input } from "@makeplane/propel/components/input";
import { InstanceService } from "@plane/services";

type Props = {
  isOpen: boolean;
  handleClose: () => void;
};

enum ESendEmailSteps {
  SEND_EMAIL = "SEND_EMAIL",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
}

const instanceService = new InstanceService();

export function SendTestEmailModal(props: Props) {
  const { isOpen, handleClose } = props;

  // state
  const [receiverEmail, setReceiverEmail] = useState("");
  const [sendEmailStep, setSendEmailStep] = useState<ESendEmailSteps>(ESendEmailSteps.SEND_EMAIL);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // reset state
  const resetState = () => {
    setReceiverEmail("");
    setSendEmailStep(ESendEmailSteps.SEND_EMAIL);
    setIsLoading(false);
    setError("");
  };

  useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
    e.preventDefault();

    setIsLoading(true);
    await instanceService
      .sendTestEmail(receiverEmail)
      .then(() => {
        setSendEmailStep(ESendEmailSteps.SUCCESS);
        return null;
      })
      .catch((sendError) => {
        setError(
          sendError?.error === "recipient_email_blocked"
            ? "该收件人已被邮箱过滤规则屏蔽，未发送测试邮件。请在「邮箱过滤」中检查规则。"
            : sendError?.error === "email_recipient_filters_unavailable"
              ? "邮箱过滤配置暂时无法读取，已停止发送。请稍后重试。"
              : sendError?.error || "邮件发送失败，请检查 SMTP 设置。"
        );
        setSendEmailStep(ESendEmailSteps.FAILED);
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-20" onClose={handleClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-backdrop transition-opacity" />
        </Transition.Child>
        <div className="fixed inset-0 z-20 overflow-y-auto">
          <div className="my-10 flex justify-center p-4 text-center sm:p-0 md:my-20">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative w-full transform rounded-lg bg-surface-1 p-5 px-4 text-left shadow-raised-200 transition-all sm:max-w-xl">
                <h3 className="text-16 leading-6 font-medium text-primary">
                  {sendEmailStep === ESendEmailSteps.SEND_EMAIL
                    ? "Send test email"
                    : sendEmailStep === ESendEmailSteps.SUCCESS
                      ? "Email send"
                      : "Failed"}{" "}
                </h3>
                <div className="pt-6 pb-2">
                  {sendEmailStep === ESendEmailSteps.SEND_EMAIL && (
                    <div className="w-full">
                      <Input
                        id="receiver_email"
                        type="email"
                        size="lg"
                        value={receiverEmail}
                        onChange={(e) => setReceiverEmail(e.target.value)}
                        placeholder="Receiver email"
                        tabIndex={0}
                      />
                    </div>
                  )}
                  {sendEmailStep === ESendEmailSteps.SUCCESS && (
                    <div className="flex flex-col gap-y-4 text-13">
                      <p>
                        We have sent the test email to {receiverEmail}. Please check your spam folder if you cannot find
                        it.
                      </p>
                      <p>If you still cannot find it, recheck your SMTP configuration and trigger a new test email.</p>
                    </div>
                  )}
                  {sendEmailStep === ESendEmailSteps.FAILED && <div className="text-13">{error}</div>}
                  <div className="mt-5 flex items-center justify-end gap-2">
                    <Button
                      variant="secondary"
                      size="md"
                      stretch="auto"
                      onClick={handleClose}
                      tabIndex={0}
                      label={sendEmailStep === ESendEmailSteps.SEND_EMAIL ? "Cancel" : "Close"}
                    />
                    {sendEmailStep === ESendEmailSteps.SEND_EMAIL && (
                      <Button
                        variant="primary"
                        size="md"
                        stretch="auto"
                        loading={isLoading}
                        onClick={handleSubmit}
                        tabIndex={0}
                        label={isLoading ? "Sending email" : "Send email"}
                      />
                    )}
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
