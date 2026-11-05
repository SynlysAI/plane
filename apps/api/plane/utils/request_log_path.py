"""避免邮件转派令牌进入请求日志。"""

ASSIGNMENT_TRANSFER_API_PATH = "/api/email-actions/assignment-transfer/"


def request_path_for_logging(request):
    """返回请求的可记录路径，隐藏邮件转派接口的查询参数。

    Args:
        request: Django 或 DRF 请求对象。

    Returns:
        转派接口的无查询串路径，或其他接口的原始完整路径。
    """
    if request.path.rstrip("/") == ASSIGNMENT_TRANSFER_API_PATH.rstrip("/"):
        return request.path
    return request.get_full_path()
