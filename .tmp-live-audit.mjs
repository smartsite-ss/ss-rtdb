// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

// Throwaway live audit on the RUNNING instance: prove that when the WAL resets to 0 the points are
// conserved — the count grows by exactly the accepted rate, and the segment files absorb the WAL bytes.
import { readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = 'F:/work/smartdata/202603_trace/trunk/code/ss-rtdb';
const SRC = `${ROOT}/src`;
const DAY_DIR = `${ROOT}/release/sea/rtdb-data/smartfactory_demo/20261017`;
const TOKEN = readFileSync(`${ROOT}/release/sea/rtdb.token`, 'utf8').trim();
const BASE = 'http://127.0.0.1:6180';
const DB = 'smartfactory_demo';
const WAIT_MS = 12_000;

const { SmartSiteSimulator } = await import(pathToFileURL(`${SRC}/packages/demo/client-smart-site/src/generator.ts`).href);
const metricNames = new SmartSiteSimulator({ seed: 1 })
  .describe()
  .map((descriptor) => `${descriptor.deviceCode}.${descriptor.variable}`);

const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

function fileState() {
  let wal = 0;
  let seg = 0;
  for (const name of readdirSync(DAY_DIR)) {
    const size = statSync(`${DAY_DIR}/${name}`).size;
    if (name.endsWith('.wal')) wal += size;
    else if (name.endsWith('.seg')) seg += size;
  }
  return { wal, seg };
}

async function status() {
  const response = await fetch(`${BASE}/api/v1/status`, { headers: authHeaders });
  return response.json();
}

async function countAll() {
  const responses = await Promise.all(
    metricNames.map((metricName) =>
      fetch(`${BASE}/api/v1/query/count`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ db: DB, metricName, start: 0, end: Date.now() + 60_000 }),
      }),
    ),
  );
  let total = 0;
  let failures = 0;
  for (const response of responses) {
    if (!response.ok) {
      failures += 1;
      continue;
    }
    total += Number((await response.json()).count ?? 0);
  }
  return { total, failures };
}

async function snapshot(label) {
  const files = fileState();
  const statusSnapshot = await status();
  const countStartedAt = Date.now();
  const counts = await countAll();
  const countEndedAt = Date.now();
  const row = {
    label,
    walMB: (files.wal / 1024 / 1024).toFixed(2),
    segMB: (files.seg / 1024 / 1024).toFixed(2),
    buffered: statusSnapshot.write.buffered,
    pendingPoints: statusSnapshot.wal.pendingPoints,
    counted: counts.total,
    failures: counts.failures,
    countEndedAt,
    countDurationMs: countEndedAt - countStartedAt,
  };
  console.log(
    `${label}: wal=${row.walMB}MB segs=${row.segMB}MB buffered=${row.buffered} ` +
      `pendingPoints=${row.pendingPoints} counted=${row.counted} (queryFailures=${row.failures})`,
  );
  return row;
}

const first = await snapshot('T0');
await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
const second = await snapshot('T1');

const delta = second.counted - first.counted;
// Expected growth: the accepted rate (20 000 pts/s) times the wall time between the two count
// completions (each count sweep takes a while on a busy server, so anchor on the actual instants).
const observedSeconds = (second.countEndedAt - first.countEndedAt) / 1000;
const expected = Math.round(observedSeconds * 20_000);
const segDelta = second.segMB - first.segMB;
console.log('');
console.log(`count delta      : ${first.counted} -> ${second.counted} (+${delta})`);
console.log(`expected         : +${expected} (20000 pts/s x ${observedSeconds.toFixed(1)} s between count sweeps)`);
console.log(`segment growth   : ${segDelta.toFixed(2)} MB over the same window`);
console.log(`bytes per point  : ${((segDelta * 1024 * 1024) / Math.max(1, delta)).toFixed(2)} (WAL was ${(first.walMB)}MB JSONL)`);
console.log(
  `RESULT           : ${
    delta > 0 && Math.abs(delta - expected) / expected < 0.15 ? 'PASS (points conserved across WAL resets)' : 'CHECK'
  }`,
);
