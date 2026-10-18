// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * InfluxDB compatibility: runtime context shared by the write / ops / InfluxQL handlers
 *
 * The context is created by `RtdbServer` per instance. Authentication and token-usage accounting stay
 * owned by the server (single credential verifier, single usage ledger); the compatibility layer only
 * asks for a scope and records compat writes through the same entry point.
 */

import type { IncomingHttpHeaders } from 'node:http';

import type { RtdbEngine } from '../../../../core/src/engine.ts';
import type { AuthPrincipal, AuthScope } from '../../auth.ts';
import type { ServerConfig } from '../../config.ts';
import type { Logger } from '../../logger.ts';

/** Counters exposed through `GET /api/v1/status` (compat.influx) and Prometheus */
export interface InfluxCompatStats {
  requests: number;
  writePoints: number;
  duplicates: number;
  /** Points merged because two lines landed in the same millisecond (ns -> ms truncation) */
  truncatedPoints: number;
  /** Lines rejected without aborting the batch (`accept_partial=true`) */
  rejectedLines: number;
  tagsFolded: number;
  tagsDropped: number;
  influxqlQueries: number;
  /** Metric names that could not be unfolded into measurement/field/tags */
  unmappedMetrics: number;
  cardinalityWarn: boolean;
}

export function createInfluxCompatStats(): InfluxCompatStats {
  return {
    requests: 0,
    writePoints: 0,
    duplicates: 0,
    truncatedPoints: 0,
    rejectedLines: 0,
    tagsFolded: 0,
    tagsDropped: 0,
    influxqlQueries: 0,
    unmappedMetrics: 0,
    cardinalityWarn: false,
  };
}

export interface InfluxCompatContext {
  config: ServerConfig;
  engine: RtdbEngine;
  logger: Logger;
  stats: InfluxCompatStats;
  /**
   * Verify a scope against the presented headers. Accepts `Bearer` and (compat only) `Token` schemes;
   * throws `RtdbError`/`HttpFailure` exactly like the native routes.
   */
  requireAuth(headers: IncomingHttpHeaders, scope: AuthScope, database?: string | null): AuthPrincipal | null;
  /** Attribute accepted points and bytes to the calling token (same ledger as the native route) */
  recordWrite(principal: AuthPrincipal | null, accepted: number, bytes: number, database: string): void;
}
