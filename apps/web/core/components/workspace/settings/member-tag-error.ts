/** 从成员标签接口错误中提取可展示的消息。 */
export function getMemberTagErrorMessage(error: unknown, fallback: string): string {
  const responseError = error as { error?: string | string[]; detail?: string; message?: string };
  const errorMessage = Array.isArray(responseError?.error) ? responseError.error[0] : responseError?.error;

  return errorMessage || responseError?.detail || responseError?.message || fallback;
}
