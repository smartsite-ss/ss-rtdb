// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Minimal dependency-free i18n for the rtdb-admin console (AGENTS.md §4 rule 12).
 *
 * English is the default locale and Chinese is the mandatory second one; the operator's choice is
 * persisted in `localStorage` so a reload keeps it. `t()` reads the reactive locale, which makes every
 * template that calls it re-render on a language switch without any extra plumbing.
 *
 * Keys are typed (`MessageKey`), so a key that exists only in one dictionary is a compile error; at
 * runtime a missing translation still degrades gracefully to English and finally to the key itself.
 */

import { ref } from 'vue';
import type { Ref } from 'vue';
import { en } from './locales/en';
import { zh } from './locales/zh';
import type { MessageKey } from './locales/en';

export type AdminLocale = 'en' | 'zh';

/** Interpolation values; `{placeholder}` segments in a message are replaced by `String(value)` */
export type MessageParams = Record<string, string | number>;

const LOCALE_STORAGE_KEY = 'rtdbAdminLocale';

const DICTIONARIES: Record<AdminLocale, Record<MessageKey, string>> = { en, zh };

function isAdminLocale(value: string | null): value is AdminLocale {
  return value === 'en' || value === 'zh';
}

function readStoredLocale(): AdminLocale {
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return isAdminLocale(stored) ? stored : 'en';
}

/** Current locale; exported as a ref so components can react to it if they need to */
export const adminLocale: Ref<AdminLocale> = ref(readStoredLocale());

/** Keep `<html lang>` and the document title in sync with the chosen locale */
function applyDocumentLanguage(): void {
  document.documentElement.lang = adminLocale.value === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.documentTitle');
}

export function setLocale(locale: AdminLocale): void {
  adminLocale.value = locale;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  applyDocumentLanguage();
}

/** Flip between the two supported locales (wired to the header language button) */
export function toggleLocale(): void {
  setLocale(adminLocale.value === 'en' ? 'zh' : 'en');
}

/**
 * Translate a key. `params` fills `{placeholder}` segments; unknown placeholders are left untouched so a
 * malformed message is visible instead of silently swallowed.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = DICTIONARIES[adminLocale.value][key] ?? en[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

applyDocumentLanguage();
