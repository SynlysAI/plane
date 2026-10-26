"""Private preview payload streaming helpers independent of API views."""

import re

from django.http import HttpResponse, StreamingHttpResponse
from rest_framework.exceptions import NotFound
from plane.settings.storage import S3Storage


def byte_range(value, size):
    """Parse one safe HTTP byte range.

    Args:
        value: Range request header.
        size: Total payload size.

    Returns:
        An inclusive start/end tuple, or ``None`` when no range is requested.
    """
    if not value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise ValueError("Invalid range")
    first, last = match.groups()
    if first:
        start, end = int(first), min(int(last), size - 1) if last else size - 1
    else:
        start, end = max(0, size - int(last)), size - 1
    if start > end or start >= size:
        raise ValueError("Unsatisfiable range")
    return start, end


def stream_preview_content(request, preview):
    """Stream an authorized private preview without exposing storage credentials.

    Args:
        request: Current HTTP request, including an optional Range header.
        preview: Ready preview cache row.

    Returns:
        A Django streaming response with private cache and sandbox headers.
    """
    try:
        selected = byte_range(request.headers.get("Range"), preview.size)
    except ValueError:
        return HttpResponse(status=416, headers={"Content-Range": f"bytes */{preview.size}"})
    storage = S3Storage()
    args = {"Bucket": storage.aws_storage_bucket_name, "Key": preview.object_key}
    if selected:
        args["Range"] = f"bytes={selected[0]}-{selected[1]}"
    try:
        result = storage.server_s3_client.get_object(**args)
    except Exception as error:
        raise NotFound() from error
    body = result["Body"]

    def chunks():
        """Release the storage connection when the consumer disconnects."""
        try:
            while chunk := body.read(64 * 1024):
                yield chunk
        finally:
            body.close()

    response = StreamingHttpResponse(chunks(), status=206 if selected else 200, content_type=preview.content_type)
    response._resource_closers.append(body.close)
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response["Accept-Ranges"] = "bytes"
    response["Content-Length"] = selected[1] - selected[0] + 1 if selected else preview.size
    if selected:
        response["Content-Range"] = f"bytes {selected[0]}-{selected[1]}/{preview.size}"
    return response
