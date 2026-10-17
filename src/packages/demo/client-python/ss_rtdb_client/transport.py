# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""Standard-library-only HTTP transport for the SDK (mirrors ``client-node``'s ``fetch`` layer).

Only ``urllib.request`` is used; there is no third-party HTTP dependency. The transport is
replaceable: :class:`RtdbClient` accepts any object exposing :meth:`send`, so tests inject a
stub that never touches the network.

Error mapping:

    - A ``4xx`` / ``5xx`` response is still a valid HTTP response and is returned as a
      :class:`Response`; the client turns it into a business error.
    - A network failure or timeout raises :class:`TransportError`, which the client retries
      (up to ``max_retries``) and finally maps through :func:`map_transport_error` into an
      ``E_CLIENT_TRANSPORT`` / ``E_CLIENT_TIMEOUT`` :class:`RtdbClientError` with ``status=0``.
"""

from __future__ import annotations

import socket
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from .errors import CLIENT_ERROR_CODE, RtdbClientError


class TransportError(Exception):
    """Transport-level failure (network error / timeout) that never produced a usable response."""

    def __init__(self, message: str, is_timeout: bool = False) -> None:
        super().__init__(message)
        #: Human-readable failure description.
        self.message = message
        #: ``True`` when the failure was a request timeout rather than a network error.
        self.is_timeout = is_timeout


class Response:
    """Minimal HTTP response wrapper: status code, headers and the raw body bytes."""

    def __init__(self, status: int, headers: Dict[str, str], body: bytes) -> None:
        #: HTTP status code.
        self.status = status
        #: Response headers as a plain ``dict``.
        self.headers = headers
        #: Raw response body bytes.
        self.body = body

    @property
    def text(self) -> str:
        """The body decoded as UTF-8 (invalid sequences are replaced, mirroring the WHATWG behaviour)."""
        return self.body.decode("utf-8", errors="replace")


class UrllibTransport:
    """Default transport built on ``urllib.request`` (stdlib only, zero third-party dependencies)."""

    def send(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[bytes],
        timeout_ms: int,
    ) -> Response:
        """Send one HTTP request and return the raw :class:`Response`.

        Raises :class:`TransportError` for network failures and timeouts.
        """
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        timeout_seconds = max(0.001, timeout_ms / 1000.0)
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as raw:
                return Response(raw.status, dict(raw.headers), raw.read())
        except urllib.error.HTTPError as error:
            # HTTPError carries a real HTTP response (4xx / 5xx); it is not a transport failure.
            return Response(error.code, dict(error.headers or {}), error.read())
        except socket.timeout as error:
            raise TransportError("Request timed out: %s" % (error,), is_timeout=True)
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, socket.timeout):
                raise TransportError("Request timed out: %s" % (reason,), is_timeout=True)
            raise TransportError("Request failed: %s" % (error,))
        except OSError as error:
            raise TransportError("Request failed: %s" % (error,))


def map_transport_error(error: Any, path: str) -> RtdbClientError:
    """Map a :class:`TransportError` (or any other exception) into the unified SDK error."""
    if isinstance(error, TransportError) and error.is_timeout:
        return RtdbClientError(
            CLIENT_ERROR_CODE["Timeout"],
            "Request %s timed out (exceeded the SDK request timeout)" % (path,),
            0,
        )
    message = error.message if isinstance(error, TransportError) else str(error)
    return RtdbClientError(
        CLIENT_ERROR_CODE["Transport"],
        "Request %s failed: %s" % (path, message),
        0,
    )
