# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""``ss-rtdb-client``: the Python SDK for the ss-rtdb HTTP REST API.

Pure-HTTP client with **zero runtime dependencies** (standard library only). It mirrors the
reference TypeScript SDK ``@ss/rtdb-client`` over the same wire protocol: the JSON value codec
(short keys ``t`` / ``v`` / ``vt`` / ``q``, with ``vt`` values ``1=f64``, ``2=i64``, ``3=bool``,
``4=string`` and i64 carried as a decimal string), the retry policy (only ``429`` and transport
failures) and the write-batch sharding policy.

Public API::

    from ss_rtdb_client import (
        RtdbClient, WriteBatchResult,
        RtdbClientError, CLIENT_ERROR_CODE, is_rtdb_client_error,
        Point, WritePoint, Series, AggregateWindow,
        VALUE_TYPE, AGGREGATE_TYPES,
        encode_write_point, decode_value, decode_point, decode_series,
        decode_aggregate_windows, encode_value, value_type_of,
        Response, TransportError, UrllibTransport,
    )

Example::

    client = RtdbClient("http://127.0.0.1:6180", token="...")
    client.write_batch("demo", [WritePoint("temperature", 1700000000000, 21.5)])
    series = client.query_range("demo", "temperature", 0, 1700000000000)
"""

from __future__ import annotations

from .client import RtdbClient, WriteBatchResult
from .errors import CLIENT_ERROR_CODE, RtdbClientError, is_rtdb_client_error
from .protocol import (
    AGGREGATE_TYPES,
    AT_POINT_STATES,
    INTERPOLATION_MODES,
    VALUE_TYPE,
    AggregateWindow,
    AtPoint,
    Point,
    Series,
    WritePoint,
    decode_aggregate_windows,
    decode_at_points,
    decode_point,
    decode_series,
    decode_value,
    encode_value,
    encode_write_point,
    value_type_of,
)
from .transport import Response, TransportError, UrllibTransport

__version__ = "0.1.0"

__all__ = [
    # Client
    "RtdbClient",
    "WriteBatchResult",
    # Errors
    "RtdbClientError",
    "CLIENT_ERROR_CODE",
    "is_rtdb_client_error",
    # Protocol data model
    "Point",
    "WritePoint",
    "Series",
    "AggregateWindow",
    "AtPoint",
    "VALUE_TYPE",
    "AGGREGATE_TYPES",
    "INTERPOLATION_MODES",
    "AT_POINT_STATES",
    # Protocol codec
    "encode_write_point",
    "encode_value",
    "value_type_of",
    "decode_value",
    "decode_point",
    "decode_series",
    "decode_aggregate_windows",
    "decode_at_points",
    # Transport
    "Response",
    "TransportError",
    "UrllibTransport",
]
