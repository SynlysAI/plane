"""Small transport-neutral error envelope; never includes submitted bodies or tokens."""


class WeeklyReportError(Exception):
    def __init__(self, code, message, status=400, operation_id=None):
        super().__init__(message)
        self.code, self.status, self.operation_id = code, status, operation_id

    def data(self):
        return {
            "error_code": self.code,
            "message": str(self),
            "retryable": self.status == 503,
            "operation_id": str(self.operation_id) if self.operation_id else None,
        }
