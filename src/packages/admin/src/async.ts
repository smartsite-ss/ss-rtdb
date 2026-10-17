// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Shared async-action plumbing for the rtdb-admin console panels.
 *
 * Every panel performs the same three steps around a REST call (mark busy, surface the error or the
 * success note, clear busy), so the behaviour lives here instead of being copied into each panel.
 */

import { ref } from 'vue';
import type { Ref } from 'vue';
import { RtdbAdminApiError } from './api';

export interface AsyncAction {
  busy: Ref<boolean>;
  errorMessage: Ref<string>;
  successMessage: Ref<string>;
  /** Runs `action`, recording its outcome; returns `undefined` when the call failed */
  run: <TResult>(action: () => Promise<TResult>, successText?: string) => Promise<TResult | undefined>;
}

export function describeError(error: unknown): string {
  if (error instanceof RtdbAdminApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useAsyncAction(): AsyncAction {
  const busy = ref(false);
  const errorMessage = ref('');
  const successMessage = ref('');

  async function run<TResult>(
    action: () => Promise<TResult>,
    successText?: string,
  ): Promise<TResult | undefined> {
    busy.value = true;
    errorMessage.value = '';
    successMessage.value = '';
    try {
      const result = await action();
      if (successText !== undefined) successMessage.value = successText;
      return result;
    } catch (error) {
      errorMessage.value = describeError(error);
      return undefined;
    } finally {
      busy.value = false;
    }
  }

  return { busy, errorMessage, successMessage, run };
}
