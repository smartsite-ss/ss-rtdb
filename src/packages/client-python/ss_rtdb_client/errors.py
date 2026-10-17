# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""SDK error model (mirrors `client-node/src/errors.ts`).

The SDK carries a single exception type, `RtdbClientError`, so that both server business
errors and transport-level failures share one shape:

    - ``status``: HTTP status code; ``0`` means a transport-level failure (network / timeout)
      that never received a response.
    - ``code``: server error code from the response body (for example ``E_BATCH_TOO_LARGE``),
      or one of the client-side codes in ``CLIENT_ERROR_CODE``.
    - ``message``: human-readable message.
    - ``details``: optional ``details`` list from the server error body (invalid point indexes
      / line numbers); empty when absent.
"""

from __future__ import annotations

from typing import Any, List, Optional

#: Error codes raised on the client side; the server always returns its own codes verbatim.
CLIENT_ERROR_CODE = {
    # Network failure, DNS failure, connection reset, or an abnormal response stream.
    "Transport": "E_CLIENT_TRANSPORT",
    # Request timeout (the configured ``timeout_ms`` was exceeded).
    "Timeout": "E_CLIENT_TIMEOUT",
    # Invalid call arguments detected locally before any request is sent.
    "InvalidArgument": "E_CLIENT_INVALID_ARGUMENT",
}


class RtdbClientError(Exception):
    """Unified SDK error (server business errors and transport errors share one type)."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 0,
        details: Optional[List[Any]] = None,
    ) -> None:
        super().__init__(message)
        #: Server error code (``E_*``) or a member of :data:`CLIENT_ERROR_CODE`.
        self.code = code
        #: Human-readable message.
        self.message = message
        #: HTTP status code; ``0`` = transport-level failure (no response received).
        self.status = status
        #: Error details from the server body (invalid point indexes / line numbers).
        self.details = list(details) if details else []

    def __repr__(self) -> str:  # pragma: no cover - debugging aid only
        return "RtdbClientError(code=%r, status=%r, message=%r)" % (self.code, self.status, self.message)


def is_rtdb_client_error(error: Any) -> bool:
    """Return ``True`` when ``error`` is an :class:`RtdbClientError`."""
    return isinstance(error, RtdbClientError)
