# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""``ss-rtdb-client``: the Python SDK over the Form B HTTP protocol.

Scope: the query/write surface (``write_batch`` / ``query_range`` / ``query_last`` / ``query_last_batch`` /
``query_count`` / ``query_aggregate`` / ``status``) plus one deliberately added helper
(``write_line_protocol``, see its docstring), and two built-in policies:

    - **Retry**: only for ``429 E_RATE_LIMITED`` and transport failures (network / timeout),
      with exponential backoff, at most ``max_retries`` (default 3, capped at 3) extra
      attempts; business errors (``400`` / ``401`` / ``403`` / ``404`` / ``413`` / ``500`` ...)
      are **never** retried.
    - **Sharding**: ``write_batch`` splits the input into batches of at most
      ``max_batch_points`` (default 100000) and sends them **sequentially**, preserving order;
      a failing chunk aborts the remaining chunks and its error is raised.

Design notes: the SDK holds **no engine dependency** (HTTP only, local codec in
:mod:`ss_rtdb_client.protocol`); ``Retry-After`` is **not** honored (the server always sends a
fixed ``1s`` and callers need bounded, predictable latency).
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import quote

from .errors import CLIENT_ERROR_CODE, RtdbClientError
from .protocol import (
    AGGREGATE_TYPES,
    INTERPOLATION_MODES,
    AggregateWindow,
    AtPoint,
    Point,
    Series,
    WritePoint,
    _is_integer_number,
    _is_number,
    decode_aggregate_windows,
    decode_at_points,
    decode_point,
    decode_series,
    encode_write_point,
)
from .transport import TransportError, UrllibTransport, map_transport_error

# ---------- Constants ----------

#: Default request timeout (ms).
DEFAULT_TIMEOUT_MS = 10000
MIN_TIMEOUT_MS = 1000
MAX_TIMEOUT_MS = 60000

#: Default extra attempts for retryable failures.
DEFAULT_MAX_RETRIES = 3
MAX_RETRIES_LIMIT = 3

#: Default chunk size of a single write batch (points).
DEFAULT_MAX_BATCH_POINTS = 100000

#: Default backoff base (ms); the wait for attempt ``n`` is ``base * 2 ** n``.
DEFAULT_RETRY_DELAY_MS = 200

#: The only HTTP status that participates in backoff retry (core backpressure).
RETRYABLE_STATUS = 429

JSON_CONTENT_TYPE = "application/json; charset=utf-8"
LINE_PROTOCOL_CONTENT_TYPE = "text/plain; charset=utf-8"

#: Characters left unescaped, mirroring JavaScript's ``encodeURIComponent``.
_URL_SAFE_CHARACTERS = "!*'()"


@dataclass
class WriteBatchResult:
    """Result of a write batch / Line Protocol write."""

    #: Points actually accepted (sum over chunks, after server-side dedupe).
    accepted: int
    #: Points discarded as duplicates (sum over chunks).
    duplicates: int = 0


class RtdbClient:
    """Pure-HTTP client for one ss-rtdb server instance.

    Options (``client-node``'s ``RtdbClientOptions``, snake_case here):

        - ``base_url`` (required): service base URL, e.g. ``http://127.0.0.1:6180``;
          trailing slashes are stripped; empty / whitespace -> ``E_CLIENT_INVALID_ARGUMENT``.
        - ``token`` (optional): when non-empty, sent as ``Authorization: Bearer <token>``.
        - ``timeout_ms`` (default 10000, clamped to 1000..60000).
        - ``max_retries`` (default 3, clamped to 0..3): extra attempts after the first.
        - ``max_batch_points`` (default 100000): ``write_batch`` shards into chunks of at most
          this many points.
        - ``retry_delay_ms`` (default 200): backoff base; the wait for attempt ``n`` is
          ``retry_delay_ms * (2 ** n)``.
        - ``transport`` (optional): a replaceable transport object (any object exposing
          ``send(method, url, headers, body, timeout_ms) -> Response``), or a zero-argument
          callable returning one. Defaults to :class:`~ss_rtdb_client.transport.UrllibTransport`.
    """

    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        max_retries: Optional[int] = None,
        max_batch_points: Optional[int] = None,
        retry_delay_ms: Optional[int] = None,
        transport: Optional[Any] = None,
    ) -> None:
        if not isinstance(base_url, str) or len(base_url.strip()) == 0:
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "RtdbClient.options.base_url must be a non-empty string",
            )
        self._base_url = base_url.strip().rstrip("/")
        self._token = token if isinstance(token, str) else ""
        self._timeout_ms = _clamp_integer(
            DEFAULT_TIMEOUT_MS if timeout_ms is None else timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS
        )
        self._max_retries = _clamp_integer(
            DEFAULT_MAX_RETRIES if max_retries is None else max_retries, 0, MAX_RETRIES_LIMIT
        )
        self._max_batch_points = max(1, _to_int(max_batch_points, DEFAULT_MAX_BATCH_POINTS))
        self._retry_delay_ms = max(0, _to_int(retry_delay_ms, DEFAULT_RETRY_DELAY_MS))
        if transport is None:
            self._transport: Any = UrllibTransport()
        elif callable(transport) and not hasattr(transport, "send"):
            self._transport = transport()
        else:
            self._transport = transport

    # ---------- Write ----------

    def write_batch(self, database: str, points: Sequence[WritePoint]) -> WriteBatchResult:
        """Write points; when the input exceeds ``max_batch_points`` it is chunked and sent in order.

        A whole chunk is either accepted or rejected (the server applies no partial success), so a
        failure aborts the remaining chunks and propagates the server error; ``accepted`` /
        ``duplicates`` sum only the chunks that already succeeded.
        """
        database_name = _require_database_name(database)
        accepted = 0
        duplicates = 0
        offset = 0
        total = len(points)
        while offset < total:
            chunk = points[offset : offset + self._max_batch_points]
            body = [encode_write_point(point) for point in chunk]
            response = self._request("POST", "/api/v1/write?db=" + _encode_component(database_name), body)
            record = _require_object(response, "write response body")
            accepted += _read_integer_field(record, "accepted")
            if "duplicates" in record:
                duplicates += _read_integer_field(record, "duplicates")
            offset += self._max_batch_points
        return WriteBatchResult(accepted=accepted, duplicates=duplicates)

    def write_line_protocol(self, database: str, body: str) -> WriteBatchResult:
        """Extra method beyond the six JSON methods: write raw Line Protocol text.

        ``POST /api/v1/write?db=<db>`` with ``Content-Type: text/plain; charset=utf-8`` and the raw
        Line Protocol body; the server accepts either JSON or Line Protocol on the same route.
        """
        database_name = _require_database_name(database)
        if not isinstance(body, str):
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "Line Protocol body must be a string",
            )
        response = self._request(
            "POST",
            "/api/v1/write?db=" + _encode_component(database_name),
            body,
            LINE_PROTOCOL_CONTENT_TYPE,
        )
        record = _require_object(response, "write response body")
        accepted = _read_integer_field(record, "accepted")
        duplicates = _read_integer_field(record, "duplicates") if "duplicates" in record else 0
        return WriteBatchResult(accepted=accepted, duplicates=duplicates)

    # ---------- Query ----------

    def query_range(
        self,
        database: str,
        metric_name: str,
        start: int,
        end: int,
        limit: Optional[int] = None,
        order: Optional[str] = None,
    ) -> Series:
        """Range read (``POST /api/v1/query/range``); ``order`` defaults to ``asc`` on the server."""
        body: Dict[str, Any] = {
            "db": _require_database_name(database),
            "metricName": _require_metric_name(metric_name),
            "start": start,
            "end": end,
        }
        if limit is not None:
            body["limit"] = limit
        if order is not None:
            body["order"] = order
        response = self._request("POST", "/api/v1/query/range", body)
        record = _require_object(response, "query/range response body")
        series = _require_object(record.get("series"), "query/range response series")
        return decode_series(series)

    def query_last(
        self,
        database: str,
        metric_name: str,
        before: Optional[int] = None,
    ) -> Optional[Point]:
        """Return the latest point at or before ``before`` (or the latest overall); ``None`` when empty."""
        body: Dict[str, Any] = {
            "db": _require_database_name(database),
            "metricName": _require_metric_name(metric_name),
        }
        if before is not None:
            body["before"] = before
        response = self._request("POST", "/api/v1/query/last", body)
        record = _require_object(response, "query/last response body")
        point = record.get("point")
        if point is None:
            return None
        return decode_point(point)

    def query_last_batch(
        self,
        database: str,
        metric_names: Sequence[str],
        before: Optional[int] = None,
    ) -> Dict[str, Optional[Point]]:
        """Latest point of many metrics in one round trip (``POST /api/v1/query/last-batch``).

        The returned dict keeps the response (= request) order; a metric without a point (or a name the
        server no longer knows) maps to ``None``. At most 1000 names per call.
        """
        if len(metric_names) == 0:
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "query_last_batch metric_names must contain at least one metric name",
            )
        body: Dict[str, Any] = {
            "db": _require_database_name(database),
            "metricNames": [_require_metric_name(name) for name in metric_names],
        }
        if before is not None:
            body["before"] = before
        response = self._request("POST", "/api/v1/query/last-batch", body)
        record = _require_object(response, "query/last-batch response body")
        entries = record.get("points")
        if not isinstance(entries, list):
            raise RtdbClientError(
                CLIENT_ERROR_CODE["Transport"],
                "query/last-batch response body.points must be a list",
            )
        latest: Dict[str, Optional[Point]] = {}
        for entry in entries:
            item = _require_object(entry, "query/last-batch response entry")
            metric_name = item.get("metricName")
            if not isinstance(metric_name, str):
                raise RtdbClientError(
                    CLIENT_ERROR_CODE["Transport"],
                    "query/last-batch response entry.metricName must be a string",
                )
            point = item.get("point")
            latest[metric_name] = None if point is None else decode_point(point)
        return latest

    def query_count(
        self,
        database: str,
        metric_name: str,
        start: int,
        end: int,
        exact: Optional[bool] = None,
    ) -> int:
        """Count points in ``[start, end]`` (``POST /api/v1/query/count``)."""
        body: Dict[str, Any] = {
            "db": _require_database_name(database),
            "metricName": _require_metric_name(metric_name),
            "start": start,
            "end": end,
        }
        if exact is not None:
            body["exact"] = exact
        response = self._request("POST", "/api/v1/query/count", body)
        record = _require_object(response, "query/count response body")
        return _read_integer_field(record, "count")

    def query_aggregate(
        self,
        database: str,
        metric_name: str,
        start: int,
        end: int,
        aggregate_type: str,
        window_ms: int,
    ) -> List[AggregateWindow]:
        """Window aggregation (``POST /api/v1/query/aggregate``).

        ``aggregate_type`` is one of ``avg`` / ``sum`` / ``min`` / ``max`` / ``count`` / ``last``.
        """
        if aggregate_type not in AGGREGATE_TYPES:
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "Unsupported aggregate type: %s (expected one of %s)"
                % (aggregate_type, ", ".join(AGGREGATE_TYPES)),
            )
        body: Dict[str, Any] = {
            "db": _require_database_name(database),
            "metricName": _require_metric_name(metric_name),
            "start": start,
            "end": end,
            "type": aggregate_type,
            "windowMs": window_ms,
        }
        response = self._request("POST", "/api/v1/query/aggregate", body)
        record = _require_object(response, "query/aggregate response body")
        windows = record.get("windows")
        if not isinstance(windows, list):
            raise RtdbClientError(
                CLIENT_ERROR_CODE["Transport"],
                "query/aggregate response is missing the windows array",
            )
        return decode_aggregate_windows(windows)

    def query_at(
        self,
        database: str,
        metric_name: str,
        timestamps: List[int],
        mode: str = "step",
    ) -> List[AtPoint]:
        """Batch point-in-time lookup (``POST /api/v1/query/at``; Interpolation Detailed Design §4.3).

        ``mode='step'`` (default) = previous-value hold; ``mode='linear'`` = piecewise-linear
        between neighbors (f64/i64 metrics only). Each result carries ``state`` telling apart a
        real stored point (``exact``) from a computed one (``interpolated`` / ``extrapolated``).
        """
        if mode not in INTERPOLATION_MODES:
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "Unsupported interpolation mode: %s (expected one of %s)"
                % (mode, ", ".join(INTERPOLATION_MODES)),
            )
        if not isinstance(timestamps, list) or len(timestamps) == 0:
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "query_at requires a non-empty timestamps list",
            )
        body: Dict[str, Any] = {
            "db": _require_database_name(database),
            "metricName": _require_metric_name(metric_name),
            "timestamps": timestamps,
            "mode": mode,
        }
        response = self._request("POST", "/api/v1/query/at", body)
        record = _require_object(response, "query/at response body")
        points = record.get("points")
        if not isinstance(points, list):
            raise RtdbClientError(
                CLIENT_ERROR_CODE["Transport"],
                "query/at response is missing the points array",
            )
        return decode_at_points(points)

    # ---------- Management ----------

    def status(self) -> Dict[str, Any]:
        """Plain ``dict`` of the ``GET /api/v1/status`` body (the server runtime metrics)."""
        response = self._request("GET", "/api/v1/status")
        return _require_object(response, "status response body")

    # ---------- Transport with retry ----------

    def _request(
        self,
        method: str,
        path: str,
        payload: Any = None,
        content_type: str = JSON_CONTENT_TYPE,
    ) -> Any:
        """Send one request with retry.

        ``429`` and transport failures back off exponentially up to ``max_retries`` extra attempts;
        every other outcome (including 4xx / 5xx business errors) returns or raises immediately.
        """
        headers: Dict[str, str] = {}
        body_bytes: Optional[bytes] = None
        if payload is not None:
            headers["Content-Type"] = content_type
            if isinstance(payload, str):
                body_bytes = payload.encode("utf-8")
            else:
                body_bytes = json.dumps(payload).encode("utf-8")
        if len(self._token) > 0:
            headers["Authorization"] = "Bearer " + self._token
        url = self._base_url + path

        attempt = 0
        while True:
            try:
                response = self._transport.send(method, url, headers, body_bytes, self._timeout_ms)
                if response.status == RETRYABLE_STATUS and attempt < self._max_retries:
                    self._sleep_backoff(attempt)
                    attempt += 1
                    continue
                if not (200 <= response.status < 300):
                    raise _to_response_error(response, path)
                return _read_response_body(response, path)
            except TransportError as error:
                if attempt < self._max_retries:
                    self._sleep_backoff(attempt)
                    attempt += 1
                    continue
                raise map_transport_error(error, path)

    def _sleep_backoff(self, attempt: int) -> None:
        delay_ms = self._retry_delay_ms * (2 ** attempt)
        if delay_ms > 0:
            time.sleep(delay_ms / 1000.0)


# ---------- Internals: response handling ----------


def _to_response_error(response: Any, path: str) -> RtdbClientError:
    parsed = _read_json_safely(response)
    record = parsed if isinstance(parsed, dict) else {}
    code = record.get("error")
    if not isinstance(code, str):
        code = "E_HTTP_%d" % response.status
    message = record.get("message")
    if not isinstance(message, str):
        message = "Request %s failed with HTTP %d" % (path, response.status)
    details = record.get("details")
    if not isinstance(details, list):
        details = []
    return RtdbClientError(code, message, response.status, details)


def _read_response_body(response: Any, path: str) -> Any:
    text = response.text
    if len(text) == 0:
        return None
    try:
        return json.loads(text)
    except ValueError as error:
        raise RtdbClientError(
            CLIENT_ERROR_CODE["Transport"],
            "Failed to parse the response body of %s: %s" % (path, error),
        )


def _read_json_safely(response: Any) -> Any:
    try:
        text = response.text
        return None if len(text) == 0 else json.loads(text)
    except ValueError:
        return None


# ---------- Internals: validation ----------


def _require_database_name(database: Any) -> str:
    if not isinstance(database, str) or len(database) == 0:
        raise RtdbClientError(CLIENT_ERROR_CODE["InvalidArgument"], "Database name must be a non-empty string")
    return database


def _require_metric_name(metric_name: Any) -> str:
    if not isinstance(metric_name, str) or len(metric_name) == 0:
        raise RtdbClientError(CLIENT_ERROR_CODE["InvalidArgument"], "Metric name must be a non-empty string")
    return metric_name


def _require_object(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "%s must be a JSON object" % (label,))
    return value


def _read_integer_field(container: Dict[str, Any], field_name: str) -> int:
    value = container.get(field_name)
    if not _is_integer_number(value):
        raise RtdbClientError(
            CLIENT_ERROR_CODE["Transport"],
            "Response field %s must be an integer: %s" % (field_name, value),
        )
    return int(value)


def _encode_component(value: str) -> str:
    return quote(value, safe=_URL_SAFE_CHARACTERS)


def _clamp_integer(value: Any, minimum: int, maximum: int) -> int:
    if not _is_number(value):
        return minimum
    if isinstance(value, float) and not math.isfinite(value):
        return minimum
    truncated = int(value)
    if truncated < minimum:
        return minimum
    if truncated > maximum:
        return maximum
    return truncated


def _to_int(value: Any, fallback: int) -> int:
    if not _is_number(value):
        return fallback
    if isinstance(value, float) and not math.isfinite(value):
        return fallback
    return int(value)
