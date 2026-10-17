// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Atomic JSON document primitive (shared by the rtdb-server user / token stores)
 *
 * One small JSON document is persisted with "tmp + fsync + rename", so a crash or a concurrent reader never
 * observes a half-written file. Reading a missing file yields `null` (a not-yet-created store), while any other
 * IO failure is surfaced as `E_IO` instead of being silently swallowed.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { ERROR_CODE, RtdbError, isRtdbError } from '../../core/src/errors.ts';

/** Read and parse a JSON document; a missing file returns `null` */
export function readJsonFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw toIoError(`Failed to read the JSON file ${filePath}`, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RtdbError(ERROR_CODE.Io, `Failed to parse the JSON file ${filePath}: ${(error as Error).message}`);
  }
}

/** Serialize and persist a JSON document atomically (indent 2 + trailing newline) */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temporaryFilePath = `${filePath}.tmp`;
  try {
    const parentDirectory = dirname(filePath);
    if (parentDirectory.length > 0 && !existsSync(parentDirectory)) {
      mkdirSync(parentDirectory, { recursive: true });
    }
    const fileDescriptor = openSync(temporaryFilePath, 'w');
    try {
      let written = 0;
      while (written < bytes.length) {
        const chunk = writeSync(fileDescriptor, bytes, written, bytes.length - written, written);
        if (chunk <= 0) throw new RtdbError(ERROR_CODE.Io, `JSON write made no progress: ${temporaryFilePath}`);
        written += chunk;
      }
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporaryFilePath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryFilePath);
    } catch {
      // Cleanup failure does not affect the main flow (the `.tmp` sibling never matches the store file name).
    }
    throw toIoError(`Failed to write the JSON file ${filePath}`, error);
  }
}

/** Uniformly map an underlying IO exception to E_IO (an RtdbError is thrown as-is) */
function toIoError(action: string, error: unknown): RtdbError {
  if (isRtdbError(error)) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return new RtdbError(ERROR_CODE.Io, `${action}: ${code === undefined ? message : `${code} ${message}`}`);
}
