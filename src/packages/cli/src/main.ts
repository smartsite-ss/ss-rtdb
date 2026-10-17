#!/usr/bin/env node
// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` process entry: hand the raw argv to `runCli` and export its exit code
 *
 * `runCli` already renders every user-level failure, so this file only guards against unexpected top-level
 * rejections (e.g. an EPIPE while piping output).
 */

import { runCli } from './index.ts';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error('[ss-rtdb] rtdbctl failed: ', error);
  process.exitCode = 1;
}
