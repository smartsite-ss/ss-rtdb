# Copyright (c) 2025 Smart Site Team
# SPDX-License-Identifier: Apache-2.0
# https://smartsite.top/
# Contact: zkxxa@qq.com, zcwebms@gmail.com

"""End-to-end acceptance tests against a **real** ``rtdb-server`` process.

The server is started with ``node packages/server/src/main.ts`` on a free TCP port with a temp
data directory (``RTDB_AUTH_ENABLED=false``). Readiness is polled through ``GET /healthz`` with a
generous timeout, because a heavy benchmark may be running on the machine concurrently.

Acceptance criteria:
    a. write -> query point-by-point equality across all four value types (i64 comes back as an
       exact Python ``int``);
    b. baseline B5 ``diff=0``: the ``last(before)`` endpoint difference over 1000 boundaries
       matches an in-Python brute-force ``latestPointAtOrBefore`` reference;
    c. ``query_count`` / ``query_aggregate`` / ``status`` / ``write_line_protocol`` behave sanely.
"""

from __future__ import annotations

import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

from ss_rtdb_client import RtdbClient, RtdbClientError, WritePoint

#: Shared database for every end-to-end test (each test uses its own metric names).
DATABASE = "py_e2e"

#: How long to wait for ``GET /healthz`` to answer ``200``.
HEALTH_TIMEOUT_SECONDS = 60.0

#: Endpoint-difference comparison tolerance (mirrors the B5 benchmark).
DIFFERENCE_TOLERANCE = 1e-9


def pick_free_port() -> int:
    """Bind a socket to port 0, read the assigned port, and close it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def remove_tree(path: str) -> None:
    """Recursively remove ``path`` using only ``os`` (best effort, Windows-friendly)."""
    for _attempt in range(10):
        if not os.path.isdir(path):
            return
        for root, directories, files in os.walk(path, topdown=False):
            for name in files:
                try:
                    os.remove(os.path.join(root, name))
                except OSError:
                    pass
            for name in directories:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass
        try:
            os.rmdir(path)
        except OSError:
            time.sleep(0.2)


def terminate_process(process: "subprocess.Popen[bytes]") -> None:
    """Terminate (and if needed kill) the server process."""
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def capture_output(process: "subprocess.Popen[bytes]") -> str:
    """Terminate the process and return its captured stdout/stderr."""
    if process is None or process.stdout is None:
        return ""
    terminate_process(process)
    try:
        return process.stdout.read().decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return ""


def wait_until_healthy(port: int, process: "subprocess.Popen[bytes]") -> None:
    """Poll ``GET /healthz`` until it answers ``200`` or the deadline passes."""
    url = "http://127.0.0.1:%d/healthz" % port
    deadline = time.time() + HEALTH_TIMEOUT_SECONDS
    last_error = None
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                "rtdb-server exited early with code %s\n--- server output ---\n%s"
                % (process.returncode, capture_output(process))
            )
        try:
            with urllib.request.urlopen(url, timeout=2.0) as response:
                if response.status == 200:
                    return
        except Exception as error:  # noqa: BLE001 - any failure just means "not up yet"
            last_error = error
        time.sleep(0.25)
    raise RuntimeError(
        "rtdb-server did not become healthy within %.0fs (last error: %s)\n--- server output ---\n%s"
        % (HEALTH_TIMEOUT_SECONDS, last_error, capture_output(process))
    )


def latest_point_at_or_before(source, boundary):
    """Brute-force reference for the B5 baseline: the latest point at or before ``boundary``."""
    best = None
    for timestamp, value in source:
        if timestamp > boundary:
            continue
        if best is None or timestamp > best[0]:
            best = (timestamp, value)
    return best


class EndToEndTests(unittest.TestCase):
    """Spawn a real ``rtdb-server`` once for the whole test class."""

    client: RtdbClient
    process: "subprocess.Popen[bytes]"
    data_directory: str
    port: int

    @classmethod
    def setUpClass(cls) -> None:
        # tests/ -> client-python -> demo -> packages -> <repository root = src/>
        repository_root = os.path.dirname(
            os.path.dirname(
                os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            )
        )
        cls.data_directory = tempfile.mkdtemp(prefix="ss-rtdb-client-python-")
        cls.port = pick_free_port()
        cls.process = None  # type: ignore[assignment]
        environment = dict(os.environ)
        environment.update(
            {
                "RTDB_PORT": str(cls.port),
                "RTDB_HOST": "127.0.0.1",
                "RTDB_DATA_DIR": cls.data_directory,
                "RTDB_AUTH_ENABLED": "false",
                "RTDB_LOG_LEVEL": "error",
            }
        )
        command = ["node", os.path.join("packages", "server", "src", "main.ts")]
        try:
            cls.process = subprocess.Popen(
                command,
                cwd=repository_root,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            cls.client = RtdbClient("http://127.0.0.1:%d" % cls.port, timeout_ms=20000)
            wait_until_healthy(cls.port, cls.process)
        except BaseException:
            terminate_process(cls.process)
            remove_tree(cls.data_directory)
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        terminate_process(cls.process)
        remove_tree(cls.data_directory)

    # ------------------------------------------------------------------ helpers

    def assert_finite_equal(self, actual, expected) -> None:
        """Compare two floats exactly enough (all test values are exactly representable)."""
        self.assertIsInstance(actual, float)
        self.assertLessEqual(abs(actual - expected), DIFFERENCE_TOLERANCE)

    # ------------------------------------------------------------------ (a) write -> query

    def test_write_then_query_point_by_point(self) -> None:
        base_timestamp = 1_700_000_000_000
        # i64 magnitudes sit at the server's exactness boundary (|v| <= 2**53), still far beyond
        # the f64 exact-integer range that a JavaScript client could round-trip.
        i64_values = [2 ** 53 - index if index % 2 == 0 else -(2 ** 53) + index for index in range(25)]
        cases = (
            ("rt.f64", [float(index) for index in range(25)]),
            ("rt.i64", i64_values),
            ("rt.bool", [bool(index % 2) for index in range(25)]),
            ("rt.str", ["sample-%02d" % index for index in range(25)]),
        )
        points = []
        for metric_name, values in cases:
            for index, value in enumerate(values):
                points.append(WritePoint(metric_name, base_timestamp + index * 1000, value))

        result = self.client.write_batch(DATABASE, points)
        self.assertEqual(result.accepted, 100)
        self.assertEqual(result.duplicates, 0)

        for metric_name, values in cases:
            with self.subTest(metric=metric_name):
                series = self.client.query_range(DATABASE, metric_name, base_timestamp, base_timestamp + 24_000)
                self.assertEqual(series.metric_name, metric_name)
                self.assertEqual(len(series.points), len(values))

                expected = [(base_timestamp + index * 1000, value) for index, value in enumerate(values)]
                actual = [(point.timestamp, point.value) for point in series.points]
                self.assertEqual(actual, expected)  # point-by-point: timestamp + value

                for index, point in enumerate(series.points):
                    self.assertIs(type(point.value), type(values[index]))  # value type fidelity

        # i64 at the exactness boundary must survive as an exact Python int.
        i64_series = self.client.query_range(DATABASE, "rt.i64", base_timestamp, base_timestamp + 24_000)
        for index, point in enumerate(i64_series.points):
            self.assertIsInstance(point.value, int)
            self.assertNotIsInstance(point.value, bool)
            self.assertEqual(point.value, i64_values[index])

    # ------------------------------------------------------------------ (b) baseline B5

    def test_b5_endpoint_difference_is_zero(self) -> None:
        metric_name = "b5.counter"
        base_timestamp = 1_700_100_000_000
        source = []
        timestamp = base_timestamp
        value = 0.0
        for index in range(300):
            timestamp += 137 + (index * 37) % 613  # non-uniform, non-aligned gaps
            value += 3.25 + (index % 7) * 0.5  # raw cumulative counter
            source.append((timestamp, round(value, 4)))

        result = self.client.write_batch(DATABASE, [WritePoint(metric_name, ts, val) for ts, val in source])
        self.assertEqual(result.accepted, len(source))

        first_timestamp = source[0][0]
        last_timestamp = source[-1][0]

        # Sanity: `last(before)` with/without a boundary at both ends of the series.
        first_point = self.client.query_last(DATABASE, metric_name, before=first_timestamp)
        self.assertIsNotNone(first_point)
        self.assertEqual((first_point.timestamp, first_point.value), source[0])
        latest_point = self.client.query_last(DATABASE, metric_name)
        self.assertIsNotNone(latest_point)
        self.assertEqual((latest_point.timestamp, latest_point.value), source[-1])
        self.assertIsNone(self.client.query_last(DATABASE, metric_name, before=first_timestamp - 1))

        span = last_timestamp - first_timestamp
        boundaries = []
        for index in range(1000):
            mode = index % 5
            if mode == 0:
                boundaries.append(first_timestamp - 1 - index)  # before the first point
            elif mode == 1:
                boundaries.append(source[(index * 7) % len(source)][0])  # exactly on a point
            elif mode == 2:
                boundaries.append(first_timestamp + (index * 97) % span)  # between points
            elif mode == 3:
                boundaries.append(last_timestamp - (index % 50))  # near the end
            else:
                boundaries.append(last_timestamp + index)  # after the last point

        mismatches = []
        checked = 0
        for index, boundary in enumerate(boundaries):
            reference = latest_point_at_or_before(source, boundary)
            sdk_point = self.client.query_last(DATABASE, metric_name, before=boundary)

            if reference is None:
                if sdk_point is not None:
                    mismatches.append((boundary, "sdk=%r reference=None" % (sdk_point,)))
                continue
            if sdk_point is None:
                mismatches.append((boundary, "sdk=None reference=%r" % (reference,)))
                continue

            if sdk_point.timestamp != reference[0] or abs(sdk_point.value - reference[1]) > DIFFERENCE_TOLERANCE:
                mismatches.append(
                    (
                        boundary,
                        "sdk=(%s, %s) reference=%s" % (sdk_point.timestamp, sdk_point.value, reference),
                    )
                )
                continue

            # Endpoint difference: last(t <= boundary) - last(t <= range start).
            sdk_difference = sdk_point.value - source[0][1]
            reference_difference = reference[1] - source[0][1]
            if abs(sdk_difference - reference_difference) > DIFFERENCE_TOLERANCE:
                mismatches.append((boundary, "diff sdk=%s reference=%s" % (sdk_difference, reference_difference)))
                continue
            checked += 1

            # Cross-check through `query_range` as well (subset keeps the loop fast).
            if boundary >= first_timestamp and index % 50 == 0:
                series = self.client.query_range(DATABASE, metric_name, first_timestamp, boundary)
                self.assertTrue(series.points)
                self.assertEqual(series.points[-1].timestamp, reference[0])
                self.assertLessEqual(abs(series.points[-1].value - reference[1]), DIFFERENCE_TOLERANCE)

        self.assertEqual(mismatches, [], "B5 endpoint difference mismatches (first 10: %r)" % (mismatches[:10],))
        # 200 of the 1000 boundaries fall before the first point (both sides empty); the other 800
        # are fully compared (point identity + endpoint difference) -- diff must be 0 everywhere.
        self.assertEqual(checked, 800)

    # ------------------------------------------------------------------ (c) other primitives

    def test_count_aggregate_status_and_line_protocol(self) -> None:
        metric_name = "prims.f64"
        base_timestamp = 1_700_200_000_000
        values = [float(index) for index in range(1, 21)]
        points = [WritePoint(metric_name, base_timestamp + index * 1000, values[index]) for index in range(20)]
        self.assertEqual(self.client.write_batch(DATABASE, points).accepted, 20)

        self.assertEqual(self.client.query_count(DATABASE, metric_name, base_timestamp, base_timestamp + 19_000, exact=True), 20)
        self.assertEqual(self.client.query_count(DATABASE, metric_name, base_timestamp, base_timestamp + 4_000, exact=True), 5)

        range_end = base_timestamp + 19_000
        window_ms = range_end - base_timestamp + 1

        last_windows = self.client.query_aggregate(DATABASE, metric_name, base_timestamp, range_end, "last", window_ms)
        self.assertEqual(len(last_windows), 1)
        self.assert_finite_equal(last_windows[0].value, values[-1])
        self.assertEqual(last_windows[0].count, 20)
        self.assertEqual((last_windows[0].start, last_windows[0].end), (base_timestamp, base_timestamp + window_ms))

        avg_windows = self.client.query_aggregate(DATABASE, metric_name, base_timestamp, range_end, "avg", window_ms)
        self.assertEqual(len(avg_windows), 1)
        average = avg_windows[0].value
        self.assertIsInstance(average, float)
        self.assertGreaterEqual(average, min(values))
        self.assertLessEqual(average, max(values))

        status = self.client.status()
        self.assertIsInstance(status, dict)
        for key in ("uptimeMs", "databases", "metrics", "write", "wal", "segments", "cache", "gc", "query"):
            self.assertIn(key, status)
        self.assertGreaterEqual(status["uptimeMs"], 0)
        self.assertIsInstance(status["write"], dict)

        line_metric = "prims.lp"
        line_base = base_timestamp + 100_000
        lines = [
            "%s value=%s %d" % (line_metric, 1.5 + index, (line_base + index * 1000) * 1_000_000)
            for index in range(3)
        ]
        line_result = self.client.write_line_protocol(DATABASE, "\n".join(lines) + "\n")
        self.assertEqual(line_result.accepted, 3)

        line_series = self.client.query_range(DATABASE, line_metric, line_base, line_base + 2_000)
        self.assertEqual([point.timestamp for point in line_series.points], [line_base, line_base + 1000, line_base + 2000])
        for point, expected_value in zip(line_series.points, (1.5, 2.5, 3.5)):
            self.assert_finite_equal(point.value, expected_value)

    # ------------------------------------------------------------------ (d) error surface

    def test_server_error_is_a_client_error(self) -> None:
        with self.assertRaises(RtdbClientError) as context:
            self.client.query_range(DATABASE, "missing.metric", 0, 1000)
        self.assertNotEqual(context.exception.status, 0)
        self.assertTrue(context.exception.code.startswith("E_"))


if __name__ == "__main__":
    unittest.main()
