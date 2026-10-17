# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""Unit tests for :class:`RtdbClient` with an injected stub transport (no network).

Covers option validation / clamping, header construction, write-batch sharding, the retry policy
(``429`` and transport failures only), the error mapping (``status=0`` transport failures and
timeouts) and response parsing for the six methods.
"""

from __future__ import annotations

import json
import unittest

from ss_rtdb_client import (
    CLIENT_ERROR_CODE,
    AggregateWindow,
    Point,
    RtdbClient,
    RtdbClientError,
    Series,
    WriteBatchResult,
    WritePoint,
)
from ss_rtdb_client.transport import Response, TransportError

BASE_URL = "http://127.0.0.1:6180"


def json_response(status: int, payload: object) -> Response:
    """Build a :class:`Response` whose body is the JSON encoding of ``payload``."""
    return Response(status, {"content-type": "application/json"}, json.dumps(payload).encode("utf-8"))


class StubTransport:
    """Deterministic fake transport; ``handler(call, index)`` returns a ``Response`` or raises."""

    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls = []

    def send(self, method, url, headers, body, timeout_ms):  # noqa: D401 - mirror of UrllibTransport.send
        call = {
            "method": method,
            "url": url,
            "headers": dict(headers),
            "body": body,
            "timeout_ms": timeout_ms,
        }
        self.calls.append(call)
        return self.handler(call, len(self.calls))

    def parsed_body(self, index: int):
        raw = self.calls[index]["body"]
        return None if raw is None else json.loads(raw.decode("utf-8"))


def build_client(handler, **options) -> tuple:
    """Return ``(client, stub_transport)`` with the stub injected."""
    transport = StubTransport(handler)
    client = RtdbClient(BASE_URL, transport=transport, **options)
    return client, transport


def raise_transport_failure(call, index):
    raise TransportError("boom")


def raise_timeout(call, index):
    raise TransportError("slow", is_timeout=True)


class OptionValidationTests(unittest.TestCase):
    """Constructor validation and clamping (mirrors ``RtdbClientOptions``)."""

    def test_empty_base_url_rejected(self) -> None:
        for value in ("", "   ", "\t\n"):
            with self.subTest(value=value):
                with self.assertRaises(RtdbClientError) as context:
                    RtdbClient(value)
                self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])

    def test_non_string_base_url_rejected(self) -> None:
        with self.assertRaises(RtdbClientError) as context:
            RtdbClient(None)  # type: ignore[arg-type]
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])

    def test_trailing_slashes_are_stripped(self) -> None:
        client = RtdbClient("  http://host:1///  ")
        self.assertEqual(client._base_url, "http://host:1")

    def test_timeout_is_clamped(self) -> None:
        self.assertEqual(RtdbClient(BASE_URL)._timeout_ms, 10000)
        self.assertEqual(RtdbClient(BASE_URL, timeout_ms=1)._timeout_ms, 1000)
        self.assertEqual(RtdbClient(BASE_URL, timeout_ms=999999)._timeout_ms, 60000)
        self.assertEqual(RtdbClient(BASE_URL, timeout_ms=5000)._timeout_ms, 5000)

    def test_max_retries_is_clamped(self) -> None:
        self.assertEqual(RtdbClient(BASE_URL)._max_retries, 3)
        self.assertEqual(RtdbClient(BASE_URL, max_retries=-4)._max_retries, 0)
        self.assertEqual(RtdbClient(BASE_URL, max_retries=99)._max_retries, 3)
        self.assertEqual(RtdbClient(BASE_URL, max_retries=1)._max_retries, 1)

    def test_batch_points_and_retry_delay_clamped(self) -> None:
        self.assertEqual(RtdbClient(BASE_URL)._max_batch_points, 100000)
        self.assertEqual(RtdbClient(BASE_URL, max_batch_points=0)._max_batch_points, 1)
        self.assertEqual(RtdbClient(BASE_URL, max_batch_points=7)._max_batch_points, 7)
        self.assertEqual(RtdbClient(BASE_URL)._retry_delay_ms, 200)
        self.assertEqual(RtdbClient(BASE_URL, retry_delay_ms=-1)._retry_delay_ms, 0)

    def test_callable_transport_factory_is_supported(self) -> None:
        transport = StubTransport(lambda call, index: json_response(200, {"count": 1}))
        client = RtdbClient(BASE_URL, transport=lambda: transport)
        self.assertEqual(client.query_count("db1", "m", 0, 1), 1)


class HeaderTests(unittest.TestCase):
    """Authorization and content-type headers."""

    def test_token_sends_bearer_header(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"status": "ok"}), token="secret")
        client.status()
        self.assertEqual(transport.calls[0]["headers"]["Authorization"], "Bearer secret")
        self.assertNotIn("Content-Type", transport.calls[0]["headers"])

    def test_empty_token_sends_no_authorization(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"status": "ok"}))
        client.status()
        self.assertNotIn("Authorization", transport.calls[0]["headers"])

    def test_json_bodies_get_json_content_type(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"accepted": 1, "duplicates": 0}))
        client.write_batch("db1", [WritePoint("m", 1, 1.0)])
        self.assertEqual(transport.calls[0]["headers"]["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(transport.calls[0]["method"], "POST")


class WriteBatchShardingTests(unittest.TestCase):
    """Sequential sharding at ``max_batch_points`` and error abort semantics."""

    def _accepted_handler(self, call, index):
        points = json.loads(call["body"].decode("utf-8"))
        return json_response(200, {"accepted": len(points), "duplicates": 0})

    def test_120_points_split_into_50_50_20(self) -> None:
        client, transport = build_client(self._accepted_handler, max_batch_points=50)
        points = [WritePoint("m", 1000 + i, float(i)) for i in range(120)]
        result = client.write_batch("db1", points)

        self.assertEqual(len(transport.calls), 3)
        for call in transport.calls:
            self.assertEqual(call["url"], BASE_URL + "/api/v1/write?db=db1")
        sizes = [len(transport.parsed_body(i)) for i in range(3)]
        self.assertEqual(sizes, [50, 50, 20])
        self.assertEqual(result, WriteBatchResult(accepted=120, duplicates=0))

        # The first chunk is encoded correctly and preserves order / type markers.
        self.assertEqual(transport.parsed_body(0)[0], {"metricName": "m", "t": 1000, "v": 0.0, "vt": 1})
        self.assertEqual(transport.parsed_body(2)[0]["t"], 1100 + 0)

    def test_database_name_is_url_encoded(self) -> None:
        client, transport = build_client(self._accepted_handler)
        client.write_batch("a b/c", [WritePoint("m", 1, 1.0)])
        self.assertEqual(transport.calls[0]["url"], BASE_URL + "/api/v1/write?db=a%20b%2Fc")

    def test_failing_middle_chunk_aborts_remaining(self) -> None:
        def handler(call, index):
            if index == 2:
                return json_response(413, {"error": "E_BATCH_TOO_LARGE", "message": "too many points"})
            return json_response(200, {"accepted": len(json.loads(call["body"].decode("utf-8"))), "duplicates": 0})

        client, transport = build_client(handler, max_batch_points=50)
        points = [WritePoint("m", 1000 + i, float(i)) for i in range(120)]
        with self.assertRaises(RtdbClientError) as context:
            client.write_batch("db1", points)

        self.assertEqual(len(transport.calls), 2)  # the third chunk is never sent
        self.assertEqual(context.exception.status, 413)
        self.assertEqual(context.exception.code, "E_BATCH_TOO_LARGE")

    def test_empty_point_list_sends_nothing(self) -> None:
        client, transport = build_client(self._accepted_handler)
        self.assertEqual(client.write_batch("db1", []), WriteBatchResult(accepted=0, duplicates=0))
        self.assertEqual(transport.calls, [])


class RetryPolicyTests(unittest.TestCase):
    """Only ``429`` and transport failures are retried, up to ``max_retries`` extra attempts."""

    def test_429_retried_exactly_max_retries_times(self) -> None:
        def handler(call, index):
            if index <= 2:
                return json_response(429, {"error": "E_RATE_LIMITED", "message": "busy"})
            return json_response(200, {"count": 7})

        client, transport = build_client(handler, max_retries=2, retry_delay_ms=0)
        self.assertEqual(client.query_count("db1", "m", 0, 1), 7)
        self.assertEqual(len(transport.calls), 3)  # 1 initial + 2 extra attempts

    def test_429_exhaustion_raises_server_error(self) -> None:
        client, transport = build_client(
            lambda call, index: json_response(429, {"error": "E_RATE_LIMITED", "message": "busy"}),
            max_retries=2,
            retry_delay_ms=0,
        )
        with self.assertRaises(RtdbClientError) as context:
            client.query_count("db1", "m", 0, 1)
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(context.exception.status, 429)
        self.assertEqual(context.exception.code, "E_RATE_LIMITED")

    def test_transport_failure_is_retried(self) -> None:
        def handler(call, index):
            if index <= 2:
                raise TransportError("connection reset")
            return json_response(200, {"count": 5})

        client, transport = build_client(handler, max_retries=2, retry_delay_ms=0)
        self.assertEqual(client.query_count("db1", "m", 0, 1), 5)
        self.assertEqual(len(transport.calls), 3)

    def test_business_errors_are_never_retried(self) -> None:
        for status, code in ((400, "E_INVALID_RANGE"), (413, "E_BATCH_TOO_LARGE"), (500, "E_INTERNAL")):
            with self.subTest(status=status):

                def handler(call, index, status=status, code=code):
                    return json_response(status, {"error": code, "message": "nope"})

                client, transport = build_client(handler, max_retries=3, retry_delay_ms=0)
                with self.assertRaises(RtdbClientError) as context:
                    client.query_count("db1", "m", 0, 1)
                self.assertEqual(len(transport.calls), 1)
                self.assertEqual(context.exception.status, status)
                self.assertEqual(context.exception.code, code)

    def test_four_oh_four_uses_synthetic_code(self) -> None:
        client, transport = build_client(
            lambda call, index: Response(404, {}, b""),
            max_retries=3,
            retry_delay_ms=0,
        )
        with self.assertRaises(RtdbClientError) as context:
            client.status()
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(context.exception.code, "E_HTTP_404")


class ErrorMappingTests(unittest.TestCase):
    """Transport-level failures map to ``status=0`` with the correct client code."""

    def test_transport_failure_maps_to_status_zero(self) -> None:
        client, transport = build_client(raise_transport_failure, max_retries=0)
        with self.assertRaises(RtdbClientError) as context:
            client.query_count("db1", "m", 0, 1)
        self.assertEqual(context.exception.status, 0)
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["Transport"])
        self.assertEqual(len(transport.calls), 1)

    def test_timeout_maps_to_timeout_code(self) -> None:
        client, _ = build_client(raise_timeout, max_retries=0)
        with self.assertRaises(RtdbClientError) as context:
            client.query_count("db1", "m", 0, 1)
        self.assertEqual(context.exception.status, 0)
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["Timeout"])

    def test_server_error_details_are_preserved(self) -> None:
        client, _ = build_client(
            lambda call, index: json_response(
                400,
                {"error": "E_INVALID_POINT", "message": "bad point", "details": [3, 5]},
            ),
            max_retries=0,
        )
        with self.assertRaises(RtdbClientError) as context:
            client.write_batch("db1", [WritePoint("m", 1, 1.0)])
        self.assertEqual(context.exception.status, 400)
        self.assertEqual(context.exception.code, "E_INVALID_POINT")
        self.assertEqual(context.exception.details, [3, 5])

    def test_unparsable_success_body_is_transport_error(self) -> None:
        client, _ = build_client(lambda call, index: Response(200, {}, b"not json"), max_retries=0)
        with self.assertRaises(RtdbClientError) as context:
            client.status()
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["Transport"])

    def test_invalid_arguments_are_rejected_before_any_request(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"count": 0}))
        with self.assertRaises(RtdbClientError) as context:
            client.query_count("", "m", 0, 1)
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])
        with self.assertRaises(RtdbClientError):
            client.query_range("db1", "", 0, 1)
        with self.assertRaises(RtdbClientError):
            client.query_aggregate("db1", "m", 0, 1, "median", 10)
        self.assertEqual(transport.calls, [])


class QueryParsingTests(unittest.TestCase):
    """Request bodies and response decoding for the six methods."""

    def test_query_range_body_and_series(self) -> None:
        payload = {"series": {"metricName": "cpu", "points": [{"t": 10, "v": 1.5, "vt": 1}]}}
        client, transport = build_client(lambda call, index: json_response(200, payload))
        series = client.query_range("db1", "cpu", 0, 100, limit=5, order="desc")

        self.assertIsInstance(series, Series)
        self.assertEqual(series.metric_name, "cpu")
        self.assertEqual(series.points[0], Point(timestamp=10, value=1.5))
        self.assertEqual(
            transport.parsed_body(0),
            {"db": "db1", "metricName": "cpu", "start": 0, "end": 100, "limit": 5, "order": "desc"},
        )
        self.assertEqual(transport.calls[0]["url"], BASE_URL + "/api/v1/query/range")

    def test_query_range_omits_optional_fields(self) -> None:
        payload = {"series": {"metricName": "cpu", "points": []}}
        client, transport = build_client(lambda call, index: json_response(200, payload))
        client.query_range("db1", "cpu", 0, 100)
        self.assertEqual(transport.parsed_body(0), {"db": "db1", "metricName": "cpu", "start": 0, "end": 100})

    def test_query_last_null_returns_none(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"point": None}))
        self.assertIsNone(client.query_last("db1", "cpu", before=1234))
        self.assertEqual(transport.parsed_body(0), {"db": "db1", "metricName": "cpu", "before": 1234})

    def test_query_last_omits_before_and_decodes_point(self) -> None:
        payload = {"point": {"t": 99, "v": "9007199254740993", "vt": 2, "q": 1}}
        client, transport = build_client(lambda call, index: json_response(200, payload))
        point = client.query_last("db1", "cpu")
        self.assertEqual(point, Point(timestamp=99, value=9007199254740993, quality=1))
        self.assertEqual(transport.parsed_body(0), {"db": "db1", "metricName": "cpu"})

    def test_query_count(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"count": 42}))
        self.assertEqual(client.query_count("db1", "cpu", 0, 100, exact=True), 42)
        self.assertEqual(
            transport.parsed_body(0),
            {"db": "db1", "metricName": "cpu", "start": 0, "end": 100, "exact": True},
        )

    def test_query_aggregate(self) -> None:
        payload = {"windows": [{"start": 0, "end": 10, "v": 2.5, "vt": 1, "count": 4}]}
        client, transport = build_client(lambda call, index: json_response(200, payload))
        windows = client.query_aggregate("db1", "cpu", 0, 10, "avg", 10)
        self.assertEqual(len(windows), 1)
        self.assertIsInstance(windows[0], AggregateWindow)
        self.assertEqual((windows[0].start, windows[0].end, windows[0].value, windows[0].count), (0, 10, 2.5, 4))
        self.assertEqual(
            transport.parsed_body(0),
            {"db": "db1", "metricName": "cpu", "start": 0, "end": 10, "type": "avg", "windowMs": 10},
        )

    def test_status_returns_raw_dict(self) -> None:
        payload = {"uptimeMs": 5, "write": {"pointsPerSec": 1}}
        client, transport = build_client(lambda call, index: json_response(200, payload))
        self.assertEqual(client.status(), payload)
        self.assertEqual(transport.calls[0]["method"], "GET")
        self.assertEqual(transport.calls[0]["url"], BASE_URL + "/api/v1/status")

    def test_write_line_protocol_uses_text_plain(self) -> None:
        client, transport = build_client(lambda call, index: json_response(200, {"accepted": 2, "duplicates": 1}))
        result = client.write_line_protocol("db1", "m value=1.5 1000000000000000\n")
        self.assertEqual(result, WriteBatchResult(accepted=2, duplicates=1))
        self.assertEqual(transport.calls[0]["headers"]["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(transport.calls[0]["body"], b"m value=1.5 1000000000000000\n")
        self.assertEqual(transport.calls[0]["url"], BASE_URL + "/api/v1/write?db=db1")

    def test_missing_windows_array_is_transport_error(self) -> None:
        client, _ = build_client(lambda call, index: json_response(200, {}))
        with self.assertRaises(RtdbClientError) as context:
            client.query_aggregate("db1", "cpu", 0, 10, "last", 10)
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["Transport"])


if __name__ == "__main__":
    unittest.main()
