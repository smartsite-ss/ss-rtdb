# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""Pure codec unit tests (no I/O, no server).

Covers the wire value codec (short keys ``t`` / ``v`` / ``vt`` / ``q``): the four value types,
the Python ``bool``-before-``int`` trap, exact i64 round-tripping beyond 2**53, local rejection
of non-finite floats, the ``vt=1`` + ``null`` -> ``NaN`` rule, and malformed wire shapes.
"""

from __future__ import annotations

import json
import math
import unittest

from ss_rtdb_client import CLIENT_ERROR_CODE, RtdbClientError
from ss_rtdb_client.protocol import (
    VALUE_TYPE,
    AggregateWindow,
    Point,
    Series,
    WritePoint,
    decode_aggregate_windows,
    decode_point,
    decode_series,
    decode_value,
    encode_write_point,
    value_type_of,
)


class EncodeValueTypeTests(unittest.TestCase):
    """Write-side encoding: explicit ``vt`` marker and wire carrier per Python type."""

    def test_float_encodes_as_f64(self) -> None:
        encoded = encode_write_point(WritePoint("m", 1, 2.5))
        self.assertEqual(encoded["vt"], VALUE_TYPE["Float64"])
        self.assertEqual(encoded["v"], 2.5)
        self.assertIsInstance(encoded["v"], float)

    def test_int_encodes_as_i64_decimal_string(self) -> None:
        encoded = encode_write_point(WritePoint("m", 1, 42))
        self.assertEqual(encoded["vt"], VALUE_TYPE["Int64"])
        self.assertEqual(encoded["v"], "42")
        self.assertIsInstance(encoded["v"], str)

    def test_string_encodes_as_string(self) -> None:
        encoded = encode_write_point(WritePoint("m", 1, "hello"))
        self.assertEqual(encoded["vt"], VALUE_TYPE["String"])
        self.assertEqual(encoded["v"], "hello")

    def test_bool_encodes_as_bool_not_int(self) -> None:
        """The Python trap: ``bool`` is a subclass of ``int`` -- bool must win."""
        for value in (True, False):
            with self.subTest(value=value):
                encoded = encode_write_point(WritePoint("m", 1, value))
                self.assertEqual(encoded["vt"], VALUE_TYPE["Bool"])
                self.assertEqual(encoded["vt"], 3)
                self.assertIs(encoded["v"], value)
                self.assertIsInstance(encoded["v"], bool)

    def test_value_type_of_bool_before_int(self) -> None:
        self.assertEqual(value_type_of(True), 3)
        self.assertEqual(value_type_of(False), 3)
        self.assertEqual(value_type_of(0), 2)
        self.assertEqual(value_type_of(1), 2)

    def test_quality_is_carried_when_present(self) -> None:
        encoded = encode_write_point(WritePoint("m", 1, 1.0, quality=7))
        self.assertEqual(encoded["q"], 7)
        self.assertNotIn("q", encode_write_point(WritePoint("m", 1, 1.0)))

    def test_wire_shape_keys_are_short(self) -> None:
        encoded = encode_write_point(WritePoint("cpu", 1700000000000, 3))
        self.assertEqual(set(encoded.keys()), {"metricName", "t", "v", "vt"})
        self.assertEqual(encoded["metricName"], "cpu")
        self.assertEqual(encoded["t"], 1700000000000)

    def test_encoded_point_is_json_safe(self) -> None:
        text = json.dumps(encode_write_point(WritePoint("m", 1, 2 ** 53 + 1)))
        self.assertIn("9007199254740993", text)  # exact i64 survives as a decimal string
        self.assertIn('"vt": 2', text)
        self.assertNotIn("NaN", text)
        self.assertNotIn("Infinity", text)


class EncodeRejectionTests(unittest.TestCase):
    """Local validation of write points."""

    def test_non_finite_float_rejected_with_invalid_argument(self) -> None:
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                with self.assertRaises(RtdbClientError) as context:
                    encode_write_point(WritePoint("m", 1, value))
                self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])
                self.assertEqual(context.exception.status, 0)

    def test_empty_metric_name_rejected(self) -> None:
        with self.assertRaises(RtdbClientError) as context:
            encode_write_point(WritePoint("", 1, 1.0))
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])

    def test_non_integer_timestamp_rejected(self) -> None:
        with self.assertRaises(RtdbClientError) as context:
            encode_write_point(WritePoint("m", 1.5, 1.0))
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])

    def test_unsupported_value_type_rejected(self) -> None:
        with self.assertRaises(RtdbClientError) as context:
            encode_write_point(WritePoint("m", 1, None))  # type: ignore[arg-type]
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["InvalidArgument"])


class DecodeValueTests(unittest.TestCase):
    """Read-side decoding: exact i64, NaN for empty windows, and value-type fidelity."""

    def test_i64_decimal_string_narrows_to_exact_int(self) -> None:
        for value in (2 ** 63 + 17, -(2 ** 63), 32, -(2 ** 53) - 1):
            with self.subTest(value=value):
                decoded = decode_value(str(value), VALUE_TYPE["Int64"])
                self.assertIsInstance(decoded, int)
                self.assertNotIsInstance(decoded, bool)
                self.assertEqual(decoded, value)

    def test_i64_integral_number_tolerated(self) -> None:
        self.assertEqual(decode_value(5, VALUE_TYPE["Int64"]), 5)
        self.assertIsInstance(decode_value(5, VALUE_TYPE["Int64"]), int)

    def test_bool_marker(self) -> None:
        self.assertIs(decode_value(True, VALUE_TYPE["Bool"]), True)
        self.assertIs(decode_value(False, VALUE_TYPE["Bool"]), False)

    def test_string_marker(self) -> None:
        self.assertEqual(decode_value("abc", VALUE_TYPE["String"]), "abc")

    def test_f64_marker_normalises_integer_to_float(self) -> None:
        decoded = decode_value(7, VALUE_TYPE["Float64"])
        self.assertIsInstance(decoded, float)
        self.assertEqual(decoded, 7.0)

    def test_f64_marker_with_null_is_nan(self) -> None:
        decoded = decode_value(None, VALUE_TYPE["Float64"])
        self.assertIsInstance(decoded, float)
        self.assertTrue(math.isnan(decoded))

    def test_round_trip_all_four_types(self) -> None:
        cases = ((2.25, VALUE_TYPE["Float64"]), (17, VALUE_TYPE["Int64"]), (True, VALUE_TYPE["Bool"]), ("s", VALUE_TYPE["String"]))
        for value, marker in cases:
            with self.subTest(value=value):
                wire = encode_write_point(WritePoint("m", 1, value))
                self.assertEqual(wire["vt"], marker)
                relayed = json.loads(json.dumps(wire))  # simulate a JSON round trip
                decoded = decode_value(relayed["v"], relayed["vt"])
                self.assertEqual(decoded, value)
                self.assertIs(type(decoded), type(value))


class DecodeRejectionTests(unittest.TestCase):
    """Malformed wire shapes raise ``E_CLIENT_TRANSPORT`` (mirroring ``client-node``'s ``decodeValue``)."""

    def assert_transport_code(self, callable_, *args) -> RtdbClientError:
        with self.assertRaises(RtdbClientError) as context:
            callable_(*args)
        self.assertEqual(context.exception.code, CLIENT_ERROR_CODE["Transport"])
        return context.exception

    def test_unknown_type_marker(self) -> None:
        self.assert_transport_code(decode_value, 1, 9)
        self.assert_transport_code(decode_value, 1, None)

    def test_i64_bad_carrier(self) -> None:
        self.assert_transport_code(decode_value, "12abc", VALUE_TYPE["Int64"])
        self.assert_transport_code(decode_value, True, VALUE_TYPE["Int64"])
        self.assert_transport_code(decode_value, 1.5, VALUE_TYPE["Int64"])

    def test_bool_bad_carrier(self) -> None:
        self.assert_transport_code(decode_value, 1, VALUE_TYPE["Bool"])
        self.assert_transport_code(decode_value, "true", VALUE_TYPE["Bool"])

    def test_string_bad_carrier(self) -> None:
        self.assert_transport_code(decode_value, 1, VALUE_TYPE["String"])

    def test_f64_bad_carrier(self) -> None:
        self.assert_transport_code(decode_value, "1.5", VALUE_TYPE["Float64"])
        self.assert_transport_code(decode_value, True, VALUE_TYPE["Float64"])

    def test_point_missing_or_bad_fields(self) -> None:
        self.assert_transport_code(decode_point, {"v": 1, "vt": 1})  # missing t
        self.assert_transport_code(decode_point, {"t": "1", "v": 1, "vt": 1})
        self.assert_transport_code(decode_point, {"t": 1, "v": 1})  # missing vt
        self.assert_transport_code(decode_point, "not-an-object")

    def test_point_missing_value_with_f64_marker_is_nan(self) -> None:
        point = decode_point({"t": 1, "vt": 1})
        self.assertTrue(math.isnan(point.value))

    def test_series_bad_points(self) -> None:
        self.assert_transport_code(decode_series, {"metricName": "m", "points": "nope"})
        self.assert_transport_code(decode_series, "not-an-object")

    def test_windows_bad_shapes(self) -> None:
        self.assert_transport_code(decode_aggregate_windows, "nope")
        self.assert_transport_code(decode_aggregate_windows, [{"start": 1, "end": 2, "v": 1}])
        self.assert_transport_code(decode_aggregate_windows, ["nope"])


class DecodeShapeTests(unittest.TestCase):
    """Decoded shapes and the dataclass data model."""

    def test_point_shape(self) -> None:
        point = decode_point({"t": 100, "v": "9007199254740993", "vt": 2, "q": 3})
        self.assertIsInstance(point, Point)
        self.assertEqual(point.timestamp, 100)
        self.assertEqual(point.value, 9007199254740993)
        self.assertEqual(point.quality, 3)

    def test_series_shape(self) -> None:
        series = decode_series({"metricName": "m", "points": [{"t": 1, "v": 1.5, "vt": 1}]})
        self.assertIsInstance(series, Series)
        self.assertEqual(series.metric_name, "m")
        self.assertEqual(len(series.points), 1)
        self.assertEqual(series.points[0].value, 1.5)

    def test_window_shape(self) -> None:
        windows = decode_aggregate_windows([{"start": 0, "end": 10, "v": None, "vt": 1, "count": 0}])
        self.assertEqual(len(windows), 1)
        window = windows[0]
        self.assertIsInstance(window, AggregateWindow)
        self.assertEqual((window.start, window.end, window.count), (0, 10, 0))
        self.assertTrue(math.isnan(window.value))


if __name__ == "__main__":
    unittest.main()
