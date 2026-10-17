// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * rtdb-admin build configuration.
 *
 * `base: './'` keeps every asset URL relative, so a single `dist` works in both supported forms:
 *   - bundled: served by rtdb-server under `/admin/` (§3.1 route table);
 *   - standalone: published on its own static host and pointed at a remote server through the
 *     in-page settings bar (the API base URL is a runtime setting, never a build-time constant).
 *
 * The console navigates with in-page tabs instead of URL routing, so the server-side SPA fallback
 * (`/admin/<anything>` → `index.html`) never changes the page's directory and relative assets stay valid.
 */
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
