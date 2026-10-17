# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""HTTP/JSON value codec on the SDK side (the mirror image of the server `json-codec.ts`).

Wire protocol: **i64 travels as a "decimal string + ``vt`` type marker"**, with ``vt`` values
``1=f64``, ``2=i64``, ``3=bool``, ``4=string``.

    - Write side: the SDK always emits ``vt`` explicitly (``bool`` -> 3, ``int`` -> 2,
      ``str`` -> 4, finite ``float`` -> 1).
    - Read side: ``vt`` is always present, so a decimal string narrows back to ``int`` and
      ``null`` (a non-finite f64 aggregate window) maps to ``float('nan')``.

Short-key aliases: ``t`` = ``timestamp``, ``v`` = ``value``, ``q`` = ``quality``.

Data model: :class:`Point`, :class:`WritePoint`, :class:`Series` and :class:`AggregateWindow`
are :func:`dataclasses.dataclass` types with explicit field names (the Python mirror of the
``client-node`` interfaces ``ClientPoint`` / ``ClientWritePoint`` / ``ClientSeries`` /
``AggregateWindowResult``).

Python-specific trap that this module handles explicitly: ``bool`` is a subclass of ``int``,
so ``isinstance(value, bool)`` MUST be tested before ``isinstance(value, int)``; otherwise
``True`` would be encoded as an i64 instead of a bool.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from .errors import CLIENT_ERROR_CODE, RtdbClientError

#: Value type markers (identical to the server / WAL row format).
VALUE_TYPE = {
    "Float64": 1,
    "Int64": 2,
    "Bool": 3,
    "String": 4,
}

#: Aggregate operators supported by the server's ``/api/v1/query/aggregate`` route.
AGGREGATE_TYPES = ("avg", "sum", "min", "max", "count", "last")

#: f64 -> float; i64 -> int; bool -> bool; string -> str.
PointValue = Union[float, int, str, bool]

_INTEGER_TEXT = re.compile(r"^[+-]?\d+$")


@dataclass
class Point:
    """One decoded sample: millisecond timestamp, value and optional quality flags."""

    timestamp: int
    value: PointValue
    quality: Optional[int] = None


@dataclass
class WritePoint:
    """A point to be written: carries the metric name in addition to the sample fields."""

    metric_name: str
    timestamp: int
    value: PointValue
    quality: Optional[int] = None


@dataclass
class Series:
    """A named, time-ascending list of decoded points."""

    metric_name: str
    points: List[Point] = field(default_factory=list)


@dataclass
class AggregateWindow:
    """One aggregated window: ``avg`` / ``sum`` / ``count`` -> float, others -> the metric value type."""

    start: int
    end: int
    value: PointValue
    count: int


# ---------- internal numeric predicates ----------


def _is_number(value: Any) -> bool:
    """``True`` for an ``int`` / ``float`` that is not a ``bool``."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_integer_number(value: Any) -> bool:
    """``True`` when ``value`` is an integer-valued number (mirrors JS ``Number.isInteger``)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer()
    return False


# ---------- Encoding (SDK value -> wire JSON) ----------


def value_type_of(value: PointValue) -> int:
    """Infer the ``vt`` marker from a Python value (``bool`` before ``int``!).

    A non-finite number (``nan`` / ``+/-inf``) is rejected locally with
    ``E_CLIENT_INVALID_ARGUMENT`` because it has no JSON representation.
    """
    if isinstance(value, bool):
        return VALUE_TYPE["Bool"]
    if isinstance(value, int):
        return VALUE_TYPE["Int64"]
    if isinstance(value, str):
        return VALUE_TYPE["String"]
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "Numeric value must be finite (NaN / Infinity cannot be encoded): %s" % (value,),
            )
        return VALUE_TYPE["Float64"]
    raise RtdbClientError(
        CLIENT_ERROR_CODE["InvalidArgument"],
        "Unsupported value type: %s" % (type(value).__name__,),
    )


def encode_value(value: PointValue) -> Union[int, float, str, bool]:
    """Encode a single value into its JSON-safe wire carrier (i64 -> decimal string)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise RtdbClientError(
                CLIENT_ERROR_CODE["InvalidArgument"],
                "Numeric value must be finite (NaN / Infinity cannot be encoded): %s" % (value,),
            )
        return value
    raise RtdbClientError(
        CLIENT_ERROR_CODE["InvalidArgument"],
        "Unsupported value type: %s" % (type(value).__name__,),
    )


def encode_write_point(point: WritePoint) -> Dict[str, Any]:
    """Encode one write point into the wire shape ``{metricName, t, v, vt, q?}``.

    The type marker is always emitted explicitly so the server never has to infer it.
    """
    if not isinstance(point.metric_name, str) or len(point.metric_name) == 0:
        raise RtdbClientError(
            CLIENT_ERROR_CODE["InvalidArgument"],
            "WritePoint.metricName must be a non-empty string",
        )
    if not _is_integer_number(point.timestamp):
        raise RtdbClientError(
            CLIENT_ERROR_CODE["InvalidArgument"],
            "WritePoint.timestamp must be an integer (ms epoch): %s" % (point.timestamp,),
        )

    encoded: Dict[str, Any] = {"metricName": point.metric_name, "t": int(point.timestamp)}
    encoded["v"] = encode_value(point.value)
    encoded["vt"] = value_type_of(point.value)
    if point.quality is not None:
        encoded["q"] = point.quality
    return encoded


# ---------- Decoding (wire JSON -> SDK value) ----------


def decode_value(raw_value: Any, marker: Any) -> PointValue:
    """Decode a timestamped value pair.

    ``vt=1`` with ``v=None`` means a non-finite f64 (an aggregate window with no coverage) and
    maps to ``float('nan')``; ``vt=2`` accepts the decimal string form (and tolerates an
    integral number) and narrows back to an exact Python ``int``.
    """
    if marker == VALUE_TYPE["Int64"]:
        if isinstance(raw_value, str) and _INTEGER_TEXT.match(raw_value):
            return int(raw_value)
        if _is_integer_number(raw_value):
            return int(raw_value)
        raise RtdbClientError(
            CLIENT_ERROR_CODE["Transport"],
            "vt=2(i64) expects a decimal string or an integer, got %s" % (type(raw_value).__name__,),
        )
    if marker == VALUE_TYPE["Bool"]:
        if isinstance(raw_value, bool):
            return raw_value
        raise RtdbClientError(
            CLIENT_ERROR_CODE["Transport"],
            "vt=3(bool) expects a boolean, got %s" % (type(raw_value).__name__,),
        )
    if marker == VALUE_TYPE["String"]:
        if isinstance(raw_value, str):
            return raw_value
        raise RtdbClientError(
            CLIENT_ERROR_CODE["Transport"],
            "vt=4(string) expects a string, got %s" % (type(raw_value).__name__,),
        )
    if marker == VALUE_TYPE["Float64"]:
        if raw_value is None:
            return float("nan")
        if _is_number(raw_value):
            return float(raw_value)
        raise RtdbClientError(
            CLIENT_ERROR_CODE["Transport"],
            "vt=1(f64) expects a number or null, got %s" % (type(raw_value).__name__,),
        )
    raise RtdbClientError(
        CLIENT_ERROR_CODE["Transport"],
        "Unknown vt type marker: %s" % (marker,),
    )


def decode_point(record: Any) -> Point:
    """Decode one wire point ``{t, v, vt, q?}`` into a :class:`Point`."""
    if not isinstance(record, dict):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "point must be a JSON object")
    timestamp = record.get("t")
    if not _is_integer_number(timestamp):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "point.t must be an integer timestamp")
    marker = record.get("vt")
    if not _is_number(marker):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "point.vt must carry a value type marker")
    point = Point(timestamp=int(timestamp), value=decode_value(record.get("v"), int(marker)))
    quality = record.get("q")
    if _is_number(quality):
        point.quality = int(quality)
    return point


def decode_series(record: Any) -> Series:
    """Decode a wire series ``{metricName, points: [...]}`` into a :class:`Series`."""
    if not isinstance(record, dict):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "series must be a JSON object")
    points = record.get("points")
    if not isinstance(points, list):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "series.points must be an array")
    metric_name = record.get("metricName")
    return Series(
        metric_name=metric_name if isinstance(metric_name, str) else "",
        points=[decode_point(item) for item in points],
    )


def decode_aggregate_windows(windows: Any) -> List[AggregateWindow]:
    """Decode the wire window list ``[{start, end, v, vt, count}]`` into :class:`AggregateWindow` values."""
    if not isinstance(windows, list):
        raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "aggregate windows must be an array")
    decoded: List[AggregateWindow] = []
    for window in windows:
        if not isinstance(window, dict):
            raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "aggregate window must be a JSON object")
        marker = window.get("vt")
        if not _is_number(window.get("start")) or not _is_number(window.get("end")) or not _is_number(marker):
            raise RtdbClientError(CLIENT_ERROR_CODE["Transport"], "aggregate window is missing start/end/vt")
        count = window.get("count")
        decoded.append(
            AggregateWindow(
                start=int(window["start"]),
                end=int(window["end"]),
                value=decode_value(window.get("v"), int(marker)),
                count=int(count) if _is_number(count) else 0,
            )
        )
    return decoded
