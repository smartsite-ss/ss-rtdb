// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Entry point of the rtdb-admin console.
 *
 * The console is a pure static site: it is mounted either by rtdb-server under `/admin` (bundled form)
 * or on any standalone host (standalone form). Both forms use this exact build.
 */

import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');
