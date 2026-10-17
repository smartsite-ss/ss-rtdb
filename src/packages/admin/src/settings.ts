// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Runtime settings of the rtdb-admin console.
 *
 * Both supported deployment forms share one build, so the server location and the credential are
 * runtime values persisted in `localStorage` rather than build-time constants:
 *   - bundled form (served by rtdb-server under `/admin`): the API base URL stays empty and every
 *     request targets the very origin that served the page;
 *   - standalone form (published on its own host): the operator enters the remote server URL here.
 */

export interface AdminSettings {
  /** REST API base URL without a trailing slash; empty string = same origin (bundled form) */
  apiBaseUrl: string;
  /** Bearer token used for `write` / `query` / `admin` scopes; empty string = anonymous */
  accessToken: string;
}

const API_BASE_URL_STORAGE_KEY = 'rtdbAdminApiBaseUrl';
const ACCESS_TOKEN_STORAGE_KEY = 'rtdbAdminAccessToken';

export function loadAdminSettings(): AdminSettings {
  return {
    apiBaseUrl: window.localStorage.getItem(API_BASE_URL_STORAGE_KEY) ?? '',
    accessToken: window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? '',
  };
}

export function saveAdminSettings(settings: AdminSettings): void {
  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, settings.apiBaseUrl);
  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, settings.accessToken);
}

/** Strip the trailing slash so path concatenation stays predictable */
export function normalizeApiBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/, '');
}
