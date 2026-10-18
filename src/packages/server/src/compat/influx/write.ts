// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: write endpoints (`/write`, `/api/v2/write`, `/api/v3/write_lp`)
 *
 * All three endpoints share one pipeline: resolve the database, read (optionally gzip) the body, parse the
 * full line protocol, merge same-millisecond duplicates, write through `engine.writeBatch`, then answer in
 * the family's native shape (204 for all three; 200 + `rejected[]` only for `accept_partial=true`).
 *
 * Default is **atomic**: a single invalid line rejects the whole batch (no partial writes), matching the
 * native write path and avoiding half-imported migrations.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { WritePoint } from '../../../../core/src/types.ts';
import type { AuthPrincipal } from '../../auth.ts';
import { readCompatBody } from './body.ts';
import type { InfluxCompatContext } from './context.ts';
import { InfluxCompatError, sendCompatJson, sendNoContent } from './errors.ts';
import { parseCompatLineProtocol, parsePrecision } from './line-protocol.ts';
import type { TimestampPrecision } from './line-protocol.ts';
import { isDatabaseName, resolveBucketDatabase } from './naming.ts';

export type InfluxWriteFamily = 'v1' | 'v2' | 'v3';

/** Precision values accepted by InfluxDB 2.x (3.x and 1.x additionally accept minute/hour) */
const V2_PRECISIONS: readonly TimestampPrecision[] = ['ns', 'us', 'ms', 's'];

interface WriteTarget {
  database: string;
  precision: TimestampPrecision;
  acceptPartial: boolean;
  /** `no_sync` was present on a v3 request (accepted but never changes the server fsync policy) */
  noSyncRequested: boolean;
}

export async function handleInfluxWrite(
  context: InfluxCompatContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  family: InfluxWriteFamily,
  principal: AuthPrincipal | null,
): Promise<void> {
  const target = resolveTarget(context, url, family);
  const body = await readCompatBody(request, context.config.compat.influx.maxBodyBytes);
  if (body.buffer.length === 0) {
    throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Request body is empty' });
  }

  const parsed = parseCompatLineProtocol(body.buffer.toString('utf8'), {
    nowMs: Date.now(),
    precision: target.precision,
    metricPrefix: context.config.compat.influx.metricPrefix,
    tagFolding: context.config.compat.influx.tagFolding,
    fieldFolding: context.config.compat.influx.fieldFolding,
  });

  context.stats.tagsFolded += parsed.tagsFolded;
  context.stats.tagsDropped += parsed.tagsDropped;

  const rejected = parsed.issues.map((issue) => ({ line_number: issue.line, error_message: issue.message }));
  const rejecting = rejected.length > 0;
  if (rejecting && (!target.acceptPartial || parsed.points.length === 0)) {
    context.stats.rejectedLines += rejected.length;
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `partial write: ${rejected[0].error_message} (line ${rejected[0].line_number})`,
      data: rejected.slice(0, 100),
    });
  }

  const { points, merged } = mergeSameMillisecond(parsed.points, context.config.compat.influx.duplicatePolicy);
  if (points.length > context.config.write.maxBatch) {
    throw new InfluxCompatError({
      status: 413,
      code: 'request too large',
      message: `Batch has ${points.length} points, exceeding write.maxBatch=${context.config.write.maxBatch}`,
    });
  }

  let accepted = 0;
  if (points.length > 0) {
    const result = await context.engine.writeBatch(target.database, points);
    accepted = result.accepted;
  }
  const duplicates = points.length - accepted;

  context.stats.writePoints += accepted;
  context.stats.duplicates += duplicates;
  context.stats.truncatedPoints += merged;
  if (rejecting) context.stats.rejectedLines += rejected.length;
  context.recordWrite(principal, accepted, body.buffer.length, target.database);

  const headers: Record<string, string> = {
    'X-Rtdb-Accepted': String(accepted),
    'X-Rtdb-Duplicates': String(duplicates),
    'X-Rtdb-Truncated-Points': String(merged),
    'X-Rtdb-Database': target.database,
  };
  if (context.config.compat.influx.tagFolding === 'ignore' && parsed.tagsDropped > 0) {
    headers['X-Rtdb-Tags-Dropped'] = String(parsed.tagsDropped);
  }
  if (target.noSyncRequested) headers['X-Rtdb-NoSync'] = 'ignored';

  if (rejecting) {
    sendCompatJson(response, 200, {
      accepted,
      duplicates,
      truncated: merged,
      rejected: rejected.slice(0, 100),
    });
    return;
  }
  sendNoContent(response, headers);
}

function resolveTarget(context: InfluxCompatContext, url: URL, family: InfluxWriteFamily): WriteTarget {
  const compat = context.config.compat.influx;
  const precisionParam = url.searchParams.get('precision');
  const precision = parsePrecision(precisionParam);
  if (precision === null) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `Invalid precision: ${String(precisionParam)}`,
    });
  }
  if (family === 'v2' && !V2_PRECISIONS.includes(precision)) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `Invalid precision for the v2 write API: ${String(precisionParam)} (expected ns|us|ms|s)`,
    });
  }

  if (family === 'v2') {
    const org = url.searchParams.get('org') ?? url.searchParams.get('orgID') ?? compat.defaultOrg;
    if (org.length === 0) {
      throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Missing required parameter "org"' });
    }
    const bucket = url.searchParams.get('bucket');
    if (bucket !== null && bucket.length > 0) {
      return {
        database: resolveBucketDatabase(bucket),
        precision,
        acceptPartial: false,
        noSyncRequested: false,
      };
    }
    const bucketId = url.searchParams.get('bucketID');
    if (bucketId !== null && bucketId.length > 0) {
      throw new InfluxCompatError({
        status: 404,
        code: 'not found',
        message: `bucketID "${bucketId}" cannot be resolved; use the bucket name (bucket=)`,
      });
    }
    throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Missing required parameter "bucket"' });
  }

  const databaseParam = url.searchParams.get('db');
  if (databaseParam === null || databaseParam.length === 0) {
    throw new InfluxCompatError({ status: 400, code: 'invalid', message: 'Missing required parameter "db"' });
  }
  if (!isDatabaseName(databaseParam)) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: `Invalid database name (first char a letter, subsequent letters/digits/underscores, <=63 chars): ${databaseParam}`,
    });
  }

  const acceptPartialParam = (url.searchParams.get('accept_partial') ?? '').toLowerCase();
  const acceptPartial = family === 'v3' && (acceptPartialParam === 'true' || acceptPartialParam === '1');
  const noSyncRequested = family === 'v3' && url.searchParams.has('no_sync');
  if (family === 'v3' && noSyncRequested && compat.rejectNoSync) {
    throw new InfluxCompatError({
      status: 400,
      code: 'invalid',
      message: 'no_sync is not supported: the fsync policy is a server-side setting (write.fsyncPolicy)',
    });
  }

  return { database: databaseParam, precision, acceptPartial, noSyncRequested };
}

/**
 * Merge points that land in the same `(metric, millisecond)`. InfluxDB keeps the last write; the engine is
 * append-only and keeps the first persisted point, so the compatibility layer resolves the in-request case
 * here (the cross-request case is documented as not reproducible).
 */
function mergeSameMillisecond(
  points: readonly WritePoint[],
  policy: 'last' | 'first',
): { points: WritePoint[]; merged: number } {
  const indexByKey = new Map<string, number>();
  const out: WritePoint[] = [];
  let merged = 0;
  for (const point of points) {
    const key = `${point.metricName}\u0000${point.timestamp}`;
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, out.length);
      out.push(point);
      continue;
    }
    merged += 1;
    if (policy === 'last') out[existing] = point;
  }
  return { points: out, merged };
}
