// ==UserScript==
// @name         Condition 7 Standalone Dashboard Helper - NCL1
// @namespace    wprijaco.condition7.standalone.helper
// @version      1.6.4
// @description  Firebase Spark/free Condition 7 dashboard helper with React Flow username parsing fix + safer Flow /permissions verification, direct Firestore allowlist, GitHub update popup, ExSD Scanned floor totals, Rodeo refresh, and optional Slack alerts.
// @author       Prince Jacob (Wprijaco)
// @updateURL    https://raw.githubusercontent.com/prince-jacob/c7_dwell_monitor/main/Condition%207%20Dashboard.user.js
// @downloadURL  https://raw.githubusercontent.com/prince-jacob/c7_dwell_monitor/main/Condition%207%20Dashboard.user.js
// @match        file:///*
// @match        https://p2rc7dwell.thejacobslab.com/*
// @match        https://*.web.app/*
// @match        https://*.firebaseapp.com/*
// @match        https://flow-sortation-eu.amazon.com/*
// @connect      flow-sortation-eu.amazon.com
// @connect      *.amazon.com
// @connect      *.amazon.dev
// @connect      midway-auth.amazon.com
// @connect      rodeo-dub.amazon.com
// @connect      hooks.slack.com
// @connect      p2rc7dwell.thejacobslab.com
// @connect      *.web.app
// @connect      *.firebaseapp.com
// @connect      firestore.googleapis.com
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FLOW_IDENTITY_CACHE_KEY = 'condition7FlowIdentityCacheV1';
  const FLOW_CAPTURE_VERSION = '1.6.4';

  function c7IdentityClean(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function c7NormalizeLogin(value) {
    let login = c7IdentityClean(value).toLowerCase().replace(/[^a-z0-9._-]/g, '');

    // React Flow can save/render navbar text as "Welcome, wprijacoRoutingInbound..."
    // when text nodes are concatenated. Strip known navbar words if they get glued on.
    const gluedSuffixes = [
      'routing', 'inbound', 'afe', 'mainsorter', 'awcs', 'batchbuffer',
      'tools', 'language', 'english', 'francais', 'français'
    ];

    let changed = true;
    while (changed) {
      changed = false;
      for (const suffix of gluedSuffixes) {
        if (login.length > suffix.length + 2 && login.endsWith(suffix)) {
          login = login.slice(0, -suffix.length);
          changed = true;
        }
      }
    }

    return login;
  }

  function c7ExtractWelcomeLoginFromDocument(doc, htmlFallback = '') {
    // New React FSD puts the username in a navbar paragraph:
    // <p class="navbar-text">Welcome, wprijaco</p>
    const candidates = [];

    try {
      for (const el of doc.querySelectorAll('.navbar-text, p, span, div')) {
        const txt = c7IdentityClean(el.textContent || '');
        if (/^Welcome,\s*/i.test(txt)) candidates.push(txt);
      }
    } catch (_) { /* no-op */ }

    const html = String(htmlFallback || '');
    const htmlPatterns = [
      /<p[^>]*class=(?:"[^"]*\bnavbar-text\b[^"]*"|'[^']*\bnavbar-text\b[^']*'|[^>\s]*navbar-text[^>\s]*)[^>]*>\s*Welcome,\s*([a-z0-9._-]{3,40})\s*<\/p>/i,
      /Welcome,\s*([a-z0-9._-]{3,40})(?=\s*<)/i
    ];

    for (const pattern of htmlPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) candidates.push(match[1]);
    }

    for (const candidate of candidates) {
      const match = String(candidate || '').match(/^Welcome,\s*([a-z0-9._-]{3,40})\b/i);
      if (match && match[1]) return c7NormalizeLogin(match[1]);
    }

    return '';
  }

  function c7ExtractFlowLogin(htmlText) {
    const html = String(htmlText || '');

    const attrMatch = html.match(/data-ng-init=["'][^"']*username\s*=\s*(?:&quot;|&#34;|['"])([a-z0-9._-]+)(?:&quot;|&#34;|['"])/i);
    if (attrMatch && attrMatch[1]) return c7NormalizeLogin(attrMatch[1]);

    const rawMatch = html.match(/username\s*=\s*(?:&quot;|&#34;|['"])([a-z0-9._-]+)(?:&quot;|&#34;|['"])/i);
    if (rawMatch && rawMatch[1]) return c7NormalizeLogin(rawMatch[1]);

    const doc = document.implementation.createHTMLDocument('');
    doc.documentElement.innerHTML = html || (document.documentElement ? document.documentElement.outerHTML : '');
    const reactWelcomeLogin = c7ExtractWelcomeLoginFromDocument(doc, html);
    if (reactWelcomeLogin) return reactWelcomeLogin;

    return '';
  }

  function c7StoreFlowLogin(login, source, extra = {}) {
    const safeLogin = c7NormalizeLogin(login);
    if (!safeLogin) return false;
    try {
      GM_setValue(FLOW_IDENTITY_CACHE_KEY, JSON.stringify({
        login: safeLogin,
        checkedAt: Date.now(),
        source: source || 'flow-sortation-page',
        permissionsValid: extra.permissionsValid === true,
        permissionKeys: Array.isArray(extra.permissionKeys) ? extra.permissionKeys.slice(0, 40) : [],
        permissionsWarning: extra.permissionsWarning || '',
        helperVersion: FLOW_CAPTURE_VERSION
      }));
      GM_setValue('condition7LastFlowLogin', safeLogin);
      GM_setValue('condition7LastFlowLoginCheckedAt', Date.now());
      console.log(`[Condition 7 Standalone] Stored Flow Sortation login: ${safeLogin}`);
      return true;
    } catch (error) {
      console.error('[Condition 7 Standalone] Could not store Flow Sortation login:', error);
      return false;
    }
  }

  function c7ShowFlowCaptureBadge(message, good = true) {
    try {
      let badge = document.getElementById('c7-flow-capture-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'c7-flow-capture-badge';
        badge.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;border-radius:12px;font:700 12px Arial,sans-serif;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,.35);max-width:360px;';
        document.body.appendChild(badge);
      }
      badge.style.background = good ? '#047857' : '#b45309';
      badge.textContent = message;
      clearTimeout(c7ShowFlowCaptureBadge.timer);
      c7ShowFlowCaptureBadge.timer = setTimeout(() => badge.remove(), 6000);
    } catch (_) { /* no-op */ }
  }

  function c7CaptureFlowIdentityFromThisPage() {
    let attempts = 0;
    const scan = () => {
      attempts += 1;
      const login = c7ExtractFlowLogin(document.documentElement.outerHTML || '');
      if (login) {
        c7StoreFlowLogin(login, 'flow-sortation-live-page');
        c7ShowFlowCaptureBadge(`C7 Dashboard access verified as ${login}. Now refresh/open the C7 dashboard.`, true);
        return;
      }
      if (attempts < 30) {
        setTimeout(scan, 1000);
      } else {
        c7ShowFlowCaptureBadge('C7 helper could not find the Flow Sortation username on this page.', false);
        console.warn('[Condition 7 Standalone] Flow page loaded but username was not found.');
      }
    };
    scan();
  }

  if (location.hostname === 'flow-sortation-eu.amazon.com') {
    c7CaptureFlowIdentityFromThisPage();
    return;
  }

  const DASHBOARD_MARKER = 'meta[name="condition7-dashboard"][content="wprijaco-v1"]';
  if (!document.querySelector(DASHBOARD_MARKER)) return;

  const HELPER_VERSION = '1.6.4';
  const INSTANCE_ATTRIBUTE = 'data-condition7-helper-active';

  if (document.documentElement.hasAttribute(INSTANCE_ATTRIBUTE)) {
    console.warn('[Condition 7 Standalone] Another helper instance is already active. This copy will stop.');
    return;
  }
  document.documentElement.setAttribute(INSTANCE_ATTRIBUTE, HELPER_VERSION);

  // Spark/free Firebase version:
  // Approved users are checked directly from Firestore REST, not through Cloud Functions.
  // This avoids the Blaze requirement. Do not store private notes/secrets in allowedUsers docs.
  const FIREBASE_PROJECT_ID = 'p2rc7-c00a3';
  const FIRESTORE_ALLOWED_USERS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/allowedUsers`;

  const REFRESH_MS = 60_000;
  const ACCESS_RECHECK_MS = 15 * 60_000;
  const CPT_OFFSET_MIN = 60;
  const SHIP_CALLOUT_MIN = 45;
  const SLACK_MAX_PER_REFRESH = 5;
  const SLACK_MEMORY_HOURS = 12;

  const FLOW_IDENTITY_URL = 'https://flow-sortation-eu.amazon.com/NCL1/';
  const FLOW_PERMISSIONS_URL = 'https://flow-sortation-eu.amazon.com/NCL1/permissions';
  const TARGET_URL = 'http://rodeo-dub.amazon.com/NCL1/ItemList?_enabledColumns=on&enabledColumns=OUTER_SCANNABLE_ID&enabledColumns=ASIN_TITLES&WorkPool=Scanned&Fracs=NON_FRACS&DwellTimeGreaterThan=0.5&DwellTimeLessThan=2.1333333333333333&ProcessPath=PPPickToRebin4%2cPPPickToRebin2%2cPPPickToRebin3&shipmentType=CUSTOMER_SHIPMENTS';

  // Main dashboard TARGET_URL stays filtered to 30m+ dwell.
  // This extra URL is ONLY for the small "Total C7 by floor" widget.
  // It fetches Rodeo ExSD summary and reads the Scanned table totals directly.
  // This avoids the ItemList 1000-row cap and matches Rodeo's own floor totals.
  const EXSD_SCANNED_TOTAL_URL = 'https://rodeo-dub.amazon.com/NCL1/ExSD?yAxis=PROCESS_PATH&zAxis=WORK_POOL&shipmentTypes=ALL&exSDRange.quickRange=ALL&exSDRange.dailyStart=18%3A00&exSDRange.dailyEnd=06%3A00&giftOption=ALL&fulfillmentServiceClass=ALL&fracs=ALL&isEulerExSDMiss=ALL&isEulerPromiseMiss=ALL&isEulerUpgraded=ALL&isReactiveTransfer=ALL&workPool=Scanned&_workPool=on&processPath=PPPickToRebin2&processPath=PPPickToRebin3&processPath=PPPickToRebin4&processPath=&minPickPriority=MIN_PRIORITY&shipMethod=&shipOption=&sortCode=&fnSku=';

  const STORAGE = {
    slackWebhook: 'condition7StandaloneSlackWebhookV1',
    // New key deliberately starts every v1.4 installation with Slack OFF,
    // even when an older helper had alerts enabled.
    slackEnabled: 'condition7StandaloneSlackEnabledV2',
    slackSentMap: 'condition7StandaloneSlackSentMapV1'
  };

  let running = false;
  let paused = false;
  let refreshTimer = null;
  let accessTimer = null;
  let accessRequestRunning = false;
  let accessApproved = false;
  let currentLogin = '';
  let currentAccessToken = '';
  let dashboardReady = false;
  let allC7TotalsRunning = false;

  const slackPending = new Set();
  const escapeHTML = value => String(value || '').replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char]));
  const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizeLogin = value => clean(value).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const normalizeShipmentId = value => {
    const text = clean(value);
    const match = text.match(/\b\d{10,}\b/);
    return match ? match[0] : text;
  };
  const gmGet = (key, fallback) => {
    try { return GM_getValue(key, fallback); } catch (_) { return fallback; }
  };
  const gmSet = (key, value) => {
    try { GM_setValue(key, value); } catch (_) { /* no-op */ }
  };

  const FLOW_IDENTITY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

  function readFlowIdentityCache() {
    try {
      const raw = GM_getValue(FLOW_IDENTITY_CACHE_KEY, '');
      const cached = raw ? JSON.parse(raw) : null;
      if (!cached || !cached.login) return null;
      const login = normalizeLogin(cached.login);
      const checkedAt = Number(cached.checkedAt || 0);
      if (!login || !checkedAt) return null;
      return {
        login,
        checkedAt,
        ageMs: Date.now() - checkedAt,
        source: cached.source || 'flow-cache',
        permissionsValid: cached.permissionsValid === true,
        permissionKeys: Array.isArray(cached.permissionKeys) ? cached.permissionKeys : [],
        permissionsWarning: cached.permissionsWarning || ''
      };
    } catch (_) {
      return null;
    }
  }

  function firestoreValueToJS(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return String(value.stringValue || '');
    if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return Boolean(value.booleanValue);
    if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue || 0);
    if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue || 0);
    if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return String(value.timestampValue || '');
    if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
    if (value.mapValue && value.mapValue.fields) return firestoreFieldsToJS(value.mapValue.fields);
    if (value.arrayValue && Array.isArray(value.arrayValue.values)) return value.arrayValue.values.map(firestoreValueToJS);
    return undefined;
  }

  function firestoreFieldsToJS(fields) {
    const out = {};
    Object.entries(fields || {}).forEach(([key, value]) => {
      out[key] = firestoreValueToJS(value);
    });
    return out;
  }

  function isFirestoreExpiryExpired(expiresAt) {
    if (!expiresAt) return false;
    const ms = Date.parse(String(expiresAt));
    if (!Number.isFinite(ms)) return false;
    return ms <= Date.now();
  }

  function authorizeLoginWithCloud(login, context, callback) {
    const safeLogin = normalizeLogin(login);
    if (!safeLogin) {
      callback(new Error('No Amazon login was available for Firestore verification'));
      return;
    }

    // Do not add random query params here. Firestore REST rejects unknown query names.
    const url = `${FIRESTORE_ALLOWED_USERS_BASE}/${encodeURIComponent(safeLogin)}`;

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      anonymous: true,
      timeout: 15_000,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      onload: response => {
        let data = null;
        try {
          data = JSON.parse(String(response.responseText || '{}'));
        } catch (error) {
          callback(new Error(`Firestore allowlist returned invalid JSON. HTTP ${response.status || 'unknown'}`));
          return;
        }

        if (response.status === 404) {
          callback(null, {
            allowed: false,
            login: safeLogin,
            message: `${safeLogin} is not in the Firebase Firestore allowlist.`
          });
          return;
        }

        if (response.status === 403) {
          callback(new Error('Firestore blocked the allowlist read. Deploy firestore.rules and make sure Firestore database is created.'));
          return;
        }

        if (response.status && (response.status < 200 || response.status >= 300)) {
          callback(new Error(data.error?.message || `Firestore allowlist returned HTTP ${response.status}`), data);
          return;
        }

        const user = firestoreFieldsToJS(data.fields || {});
        const enabled = user.enabled === true || String(user.enabled).toLowerCase() === 'true';
        const expired = isFirestoreExpiryExpired(user.expiresAt);

        if (!enabled) {
          callback(null, {
            allowed: false,
            login: safeLogin,
            message: `${safeLogin} is disabled in the Firebase Firestore allowlist.`
          });
          return;
        }

        if (expired) {
          callback(null, {
            allowed: false,
            login: safeLogin,
            message: `${safeLogin} access has expired in Firebase Firestore.`
          });
          return;
        }

        callback(null, {
          allowed: true,
          login: safeLogin,
          role: user.role || 'viewer',
          expiresAt: user.expiresAt || '',
          message: 'Approved by Firebase Firestore allowlist.'
        });
      },
      onerror: () => callback(new Error('Firestore allowlist request failed. Check Firestore setup, HTTPS, and @connect firestore.googleapis.com permission.')),
      ontimeout: () => callback(new Error('Firestore allowlist request timed out after 15 seconds.'))
    });
  }

  function approveOrDenyCachedLogin(cached) {
    currentLogin = cached.login;
    currentAccessToken = '';
    accessApproved = false;
    stopMonitoring(true);

    const flowDiag = cached.permissionsValid
      ? `Flow alias ✅ ${cached.login} • permissions ✅ ${cached.permissionKeys?.slice(0, 4).join(', ') || 'valid'}`
      : `Flow alias ✅ ${cached.login} • permissions ⚠️ ${cached.permissionsWarning || 'not confirmed'}`;

    sendAccess('checking', {
      login: cached.login,
      message: 'Checking Firebase Firestore access…',
      detail: `${flowDiag}. Checking Firebase Firestore allowlist now.`
    });
    sendStatus('Checking Firebase Firestore access…', `${flowDiag} • Firestore allowlist check running`);

    authorizeLoginWithCloud(cached.login, cached, (error, result) => {
      if (error) {
        accessApproved = false;
        currentAccessToken = '';
        stopMonitoring(true);
        sendAccess('error', {
          login: cached.login,
          message: 'Firebase Firestore access check failed',
          detail: error.message || String(error)
        });
        sendStatus('Firebase Firestore access check failed', error.message || String(error), 'error');
        return;
      }

      if (!result || result.allowed !== true) {
        accessApproved = false;
        currentAccessToken = '';
        stopMonitoring(true);
        sendAccess('denied', {
          login: cached.login,
          message: 'Access denied',
          detail: result?.message || `${cached.login} is not authorised by the Firebase Firestore allowlist.`
        });
        sendStatus('Access denied', `${cached.login} is not approved on the Firebase Firestore allowlist`, 'error');
        return;
      }

      accessApproved = true;
      currentAccessToken = '';
      currentLogin = normalizeLogin(result.login || cached.login);
      sendAccess('approved', {
        login: currentLogin,
        message: `Access approved for ${currentLogin}`,
        detail: result.expiresAt
          ? `Firebase Firestore authorisation valid until ${result.expiresAt}.`
          : 'Firebase Firestore authorisation approved.'
      });
      const approvedDiag = cached.permissionsValid
        ? `Flow ✅ • Firebase ✅ • signed in as ${currentLogin}`
        : `Flow alias ✅ • Firebase ✅ • signed in as ${currentLogin} • ${cached.permissionsWarning || 'permissions warning'}`;
      sendStatus('Access approved', approvedDiag);
      startMonitoring();
    });
  }

  function emit(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function forceAccessGate(state, options = {}) {
    // v1.4.5: Script-only fallback. This directly updates the existing v1.4.0
    // access gate, so users do not need to replace the hosted HTML while debugging.
    const gate = document.getElementById('accessGate');
    const title = document.getElementById('accessTitle');
    const message = document.getElementById('accessMessage');
    const icon = document.getElementById('accessIcon');
    const loginBox = document.getElementById('accessLogin');
    const meta = document.getElementById('accessMeta');
    const user = document.getElementById('accessUser');
    const actionIds = ['installHelper', 'openFlow', 'openRodeo', 'retryAccess'];
    const showActions = options.actions || [];
    if (!gate || !title || !message || !icon) return;

    const login = options.login || currentLogin || '';
    let iconText = '🔎';
    let tone = 'wait';
    let heading = options.message || 'Verifying Amazon login…';
    let body = options.detail || 'Checking your Flow Sortation session.';

    if (state === 'approved') {
      gate.classList.add('hidden');
      document.body.classList.remove('c7-locked');
      if (user) {
        user.textContent = `✓ ${login || currentLogin || 'approved'}`;
        user.classList.add('ok');
      }
      return;
    }

    if (state === 'login-required') {
      iconText = '🔑';
      tone = 'bad';
      heading = options.message || 'Amazon sign-in required';
      body = options.detail || 'Open Flow Sortation, complete Midway sign-in, then retry.';
      if (!showActions.length) showActions.push('openFlow', 'retryAccess');
    } else if (state === 'denied') {
      iconText = '⛔';
      tone = 'bad';
      heading = options.message || 'Access denied';
      body = options.detail || 'This Amazon login is not authorised to use the dashboard.';
    } else if (state === 'error') {
      iconText = '⚠️';
      tone = 'bad';
      heading = options.message || 'Unable to verify access';
      body = options.detail || 'Open Flow Sortation and Rodeo, then retry verification.';
      if (!showActions.length) showActions.push('openFlow', 'openRodeo', 'retryAccess');
    }

    document.body.classList.add('c7-locked');
    gate.classList.remove('hidden');
    title.textContent = heading;
    message.textContent = body;
    icon.textContent = iconText;
    icon.className = `access-icon ${tone}`;
    if (loginBox) {
      loginBox.classList.toggle('show', Boolean(login));
      loginBox.innerHTML = login ? `Detected Amazon login: <b>${String(login).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}</b>` : '';
    }
    if (meta) meta.textContent = `Dashboard v1.6.0 • Helper v${HELPER_VERSION} • Firebase mode`;
    if (user) {
      user.textContent = login ? `Locked • ${login}` : 'Access locked';
      user.classList.remove('ok');
    }
    for (const id of actionIds) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !showActions.includes(id));
    }

    const openFlowButton = document.getElementById('openFlow');
    if (openFlowButton) {
      openFlowButton.textContent = 'Verify Amazon Login';
      openFlowButton.href = 'https://flow-sortation-eu.amazon.com/NCL1/#/afe/workforce';
      openFlowButton.target = '_blank';
      openFlowButton.rel = 'noopener noreferrer';
    }
  }

  function sendStatus(message, detail = '', level = 'info') {
    emit('condition7-status', { message, detail, level });
  }

  function sendData(detail) {
    emit('condition7-data', detail);
  }

  function sendHelperPong(requestId = '') {
    emit('condition7-helper-pong', {
      requestId,
      version: HELPER_VERSION,
      accessApproved,
      login: currentLogin || ''
    });
  }

  function sendAccess(state, options = {}) {
    forceAccessGate(state, options);
    emit('condition7-access', {
      state,
      login: options.login || currentLogin || '',
      message: options.message || '',
      detail: options.detail || '',
      helperVersion: HELPER_VERSION,
      cloudAccess: true
    });
  }

  document.addEventListener('condition7-helper-ping', event => {
    sendHelperPong(event.detail?.requestId || '');
  });

  /* ---------------------------- Access control ---------------------------- */

  function stripFlowNavbarSuffix(loginValue) {
    let login = normalizeLogin(loginValue);
    const gluedSuffixes = [
      'routing', 'inbound', 'afe', 'mainsorter', 'awcs', 'batchbuffer',
      'tools', 'language', 'english', 'francais', 'français'
    ];

    let changed = true;
    while (changed) {
      changed = false;
      for (const suffix of gluedSuffixes) {
        if (login.length > suffix.length + 2 && login.endsWith(suffix)) {
          login = login.slice(0, -suffix.length);
          changed = true;
        }
      }
    }

    return login;
  }

  function extractReactFlowWelcomeLogin(doc, html) {
    const candidates = [];

    for (const el of doc.querySelectorAll('.navbar-text, p, span, div')) {
      const txt = clean(el.textContent || '');
      if (/^Welcome,\s*/i.test(txt)) candidates.push(txt);
    }

    const htmlPatterns = [
      /<p[^>]*class=(?:"[^"]*\bnavbar-text\b[^"]*"|'[^']*\bnavbar-text\b[^']*'|[^>\s]*navbar-text[^>\s]*)[^>]*>\s*Welcome,\s*([a-z0-9._-]{3,40})\s*<\/p>/i,
      /Welcome,\s*([a-z0-9._-]{3,40})(?=\s*<)/i
    ];

    for (const pattern of htmlPatterns) {
      const match = String(html || '').match(pattern);
      if (match?.[1]) candidates.push(match[1]);
    }

    for (const candidate of candidates) {
      const match = String(candidate || '').match(/^Welcome,\s*([a-z0-9._-]{3,40})\b/i);
      if (match?.[1]) return stripFlowNavbarSuffix(match[1]);
    }

    return '';
  }

  function extractAmazonLogin(htmlText) {
    const html = String(htmlText || '');
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const element of doc.querySelectorAll('[data-ng-init]')) {
      const initText = element.getAttribute('data-ng-init') || '';
      const match = initText.match(/(?:^|[;\s])username\s*=\s*['"]([^'"]+)['"]/i);
      if (match?.[1]) return stripFlowNavbarSuffix(match[1]);
    }

    const rawMatch = html.match(/username\s*=\s*(?:&quot;|&#34;|['"])([a-z0-9._-]+)(?:&quot;|&#34;|['"])/i);
    if (rawMatch?.[1]) return stripFlowNavbarSuffix(rawMatch[1]);

    const reactWelcomeLogin = extractReactFlowWelcomeLogin(doc, html);
    if (reactWelcomeLogin) return reactWelcomeLogin;

    return '';
  }

  function looksLikeAuthenticationPage(response) {
    const finalUrl = String(response?.finalUrl || response?.responseURL || '').toLowerCase();
    const text = String(response?.responseText || '').slice(0, 250_000).toLowerCase();
    return (
      /midway|signin|sign-in|federat|sso|authportal/.test(finalUrl) ||
      /midway authentication|sign in to amazon|amazon federate|authentication required/.test(text)
    );
  }

  function stopMonitoring(clearDashboard = false) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    running = false;
    if (clearDashboard) {
      sendData({ shipments: [], sourceRows: 0, accessRevoked: true });
      renderFloorTotalsWidget([], 0);
    }
  }

  function flowResponseSummary(response, elapsedMs) {
    const status = response?.status ?? 'unknown';
    const finalUrl = String(response?.finalUrl || response?.responseURL || FLOW_IDENTITY_URL);
    const length = String(response?.responseText || '').length;
    return `Flow response: HTTP ${status} • ${Math.round(elapsedMs / 1000)}s • ${length} chars • ${finalUrl}`;
  }

  function finishAccessCheck(requestId, startedAt, doneFlag, callback) {
    if (doneFlag.value) return false;
    doneFlag.value = true;
    clearTimeout(doneFlag.stillWaitingTimer);
    clearTimeout(doneFlag.hardTimeoutTimer);
    callback(Date.now() - startedAt);
    return true;
  }

  function gmRequestText(url, options = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest is unavailable. Check Tampermonkey @grant permissions.'));
        return;
      }

      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        anonymous: false,
        timeout: options.timeout || 20_000,
        headers: options.headers || {},
        data: options.data,
        onload: response => {
          const status = Number(response.status || 0);
          if (status >= 200 && status < 400) {
            resolve({
              status,
              finalUrl: response.finalUrl || response.responseURL || url,
              text: String(response.responseText || ''),
              headers: response.responseHeaders || ''
            });
            return;
          }
          reject(new Error(`Flow Sortation returned HTTP ${status || 'unknown'}`));
        },
        ontimeout: () => reject(new Error('Flow Sortation verification request timed out.')),
        onerror: () => reject(new Error('Could not connect to Flow Sortation.'))
      });
    });
  }

  function looksLikeLoginText(text, finalUrl = '') {
    const combined = `${finalUrl}
${String(text || '').slice(0, 250_000)}`;
    return /midway|sign\s*in|signin|sign-in|login|authentication|sentry|captcha|robot|federat|sso|authportal/i.test(combined);
  }

  function makeFlowCacheBustedUrl(baseUrl, key) {
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${key}=${Date.now()}`;
  }

  function parseFlowPermissionsResponse(response) {
    const text = String(response?.text || '').trim();
    const status = Number(response?.status || 0);

    if (looksLikeLoginText(text, response?.finalUrl || '')) {
      throw new Error('Flow Sortation permissions check returned a login/authentication page. Open Flow Sortation and sign in normally.');
    }

    // HAR inspection showed /NCL1/permissions can be cached or empty in some sessions.
    // A cache-busted URL is used first, but if Flow still gives 304/empty without a login page,
    // keep the verified Flow alias and continue with a clear warning instead of locking the dashboard.
    if (status === 304 || !text) {
      return {
        permissionsValid: false,
        permissionKeys: [],
        permissionsWarning: `Flow /permissions returned ${status || 'empty'} with no JSON; alias was still verified from Flow main page.`
      };
    }

    let permissions = null;
    try {
      permissions = JSON.parse(text);
    } catch (_) {
      return {
        permissionsValid: false,
        permissionKeys: [],
        permissionsWarning: 'Flow /permissions did not return valid JSON; alias was still verified from Flow main page.'
      };
    }

    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return {
        permissionsValid: false,
        permissionKeys: [],
        permissionsWarning: 'Flow /permissions returned an unexpected response; alias was still verified from Flow main page.'
      };
    }

    return {
      permissionsValid: true,
      permissionKeys: Object.keys(permissions).filter(key => permissions[key] === true || permissions[key] === 'true'),
      permissionsWarning: ''
    };
  }

  async function verifyFlowLoginInBackground() {
    const identityUrl = makeFlowCacheBustedUrl(FLOW_IDENTITY_URL, 'c7IdentityCheck');
    const mainResponse = await gmRequestText(identityUrl, {
      timeout: 25_000,
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    });

    if (looksLikeLoginText(mainResponse.text, mainResponse.finalUrl)) {
      throw new Error('Flow Sortation authentication is required. Open Flow Sortation and complete Midway login normally.');
    }

    const login = extractAmazonLogin(mainResponse.text);
    if (!login) {
      throw new Error('Flow Sortation loaded, but the logged-in Amazon alias could not be detected.');
    }

    let permissionInfo = {
      permissionsValid: false,
      permissionKeys: [],
      permissionsWarning: 'Flow /permissions was not checked.'
    };

    try {
      const permissionsUrl = makeFlowCacheBustedUrl(FLOW_PERMISSIONS_URL, 'c7PermCheck');
      const permissionsResponse = await gmRequestText(permissionsUrl, {
        timeout: 15_000,
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
      });
      permissionInfo = parseFlowPermissionsResponse(permissionsResponse);
    } catch (error) {
      const message = error?.message || String(error);
      if (/login|auth|midway|captcha|robot|sign/i.test(message)) {
        throw error;
      }
      permissionInfo = {
        permissionsValid: false,
        permissionKeys: [],
        permissionsWarning: `Flow /permissions check was unavailable: ${message}`
      };
    }

    return {
      login,
      checkedAt: Date.now(),
      source: permissionInfo.permissionsValid
        ? 'flow-sortation-background-with-permissions'
        : 'flow-sortation-background-main-page-only',
      permissionsValid: permissionInfo.permissionsValid,
      permissionKeys: permissionInfo.permissionKeys,
      permissionsWarning: permissionInfo.permissionsWarning
    };
  }

  function verifyAccess(force = false) {
    const cachedIdentity = readFlowIdentityCache();
    if (cachedIdentity && cachedIdentity.ageMs <= FLOW_IDENTITY_MAX_AGE_MS) {
      approveOrDenyCachedLogin(cachedIdentity);
      return;
    }

    if (accessRequestRunning) {
      sendAccess('checking', {
        message: 'Still verifying Amazon login…',
        detail: 'A Flow Sortation verification request is already running. Wait a few seconds or press Retry once.'
      });
      return;
    }

    if (!force && accessApproved && currentLogin) {
      sendAccess('approved', {
        login: currentLogin,
        message: `Access approved for ${currentLogin}`
      });
      return;
    }

    accessRequestRunning = true;
    accessApproved = false;
    currentLogin = '';
    stopMonitoring(true);

    sendAccess('checking', {
      message: 'Verifying Flow Sortation session…',
      detail: 'Checking Flow main page for your Amazon login, then checking /NCL1/permissions with cache-safe fallback.'
    });
    sendStatus('Verifying Flow Sortation session…', 'Flow alias check + cache-safe /permissions check');

    verifyFlowLoginInBackground()
      .then(identity => {
        accessRequestRunning = false;
        c7StoreFlowLogin(identity.login, identity.source, {
          permissionsValid: identity.permissionsValid,
          permissionKeys: identity.permissionKeys,
          permissionsWarning: identity.permissionsWarning
        });
        approveOrDenyCachedLogin(identity);
      })
      .catch(error => {
        accessRequestRunning = false;
        accessApproved = false;
        currentLogin = '';
        stopMonitoring(true);
        sendAccess('error', {
          message: 'Verify Amazon Login',
          detail: `${error?.message || String(error)} Click Verify Amazon Login, wait for the green C7 verified message on Flow Sortation, then return here and press Retry.`,
          actions: ['openFlow', 'retryAccess']
        });
        sendStatus('Waiting for Flow Sortation verification', 'Open Flow Sortation, then retry after the green C7 verified message appears', 'error');
      });
  }


  /* ----------------------------- Floor totals ----------------------------- */

  function emptyFloorTotal(floor) {
    const labels = { '2': 'P2R2', '3': 'P2R3', '4': 'P2R4', Other: 'Other' };
    return {
      floor,
      label: labels[floor] || `P${floor}`,
      shipments: 0,
      items: 0,
      qty: 0,
      callout: 0,
      maxDwell: 0,
      shipmentIds: new Set()
    };
  }

  // This old builder is kept as fallback only. It uses the 30m+ dashboard data.
  function buildFloorTotals(shipments) {
    const floors = {
      '2': emptyFloorTotal('2'),
      '3': emptyFloorTotal('3'),
      '4': emptyFloorTotal('4')
    };

    for (const shipment of shipments || []) {
      const shipmentFloors = [...new Set((shipment.floors || []).map(String).filter(Boolean))];
      for (const floor of shipmentFloors) {
        if (!floors[floor]) floors[floor] = emptyFloorTotal(floor);

        const floorItems = (shipment.items || []).filter(item => String(item.floor || '') === floor);
        const itemCount = floorItems.length || (shipmentFloors.length === 1 ? (shipment.items || []).length : 0);
        const qty = floorItems.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);

        floors[floor].shipments += 1;
        floors[floor].items += itemCount;
        floors[floor].qty += qty;
        floors[floor].maxDwell = Math.max(floors[floor].maxDwell, Number(shipment.maxDwell || 0));
        if (shipment.calloutRisk) floors[floor].callout += 1;
      }
    }

    const ordered = ['2', '3', '4'].map(floor => floors[floor]);
    const extra = Object.keys(floors).filter(floor => !['2', '3', '4'].includes(floor)).sort().map(floor => floors[floor]);
    return [...ordered, ...extra];
  }

  function ensureFloorTotalsWidget() {
    let widget = document.getElementById('c7-floor-total-widget');
    if (widget) return widget;

    const styleId = 'c7-floor-total-widget-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        #c7-floor-total-widget{display:flex;gap:10px;align-items:stretch;flex-wrap:wrap;background:rgba(18,26,43,.86);border:1px solid rgba(255,255,255,.08);padding:10px 12px;border-radius:14px;margin:0 0 14px 0;box-shadow:0 18px 50px rgba(0,0,0,.22)}
        #c7-floor-total-widget .c7ft-title{font-size:12px;color:#91a0b8;font-weight:800;display:flex;align-items:center;margin-right:2px;min-width:150px;line-height:1.35}
        #c7-floor-total-widget .c7ft-card{background:#0e1727;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:9px 11px;min-width:136px;flex:1}
        #c7-floor-total-widget .c7ft-card b{display:block;font-size:20px;line-height:1.1;color:#f5f7fb}
        #c7-floor-total-widget .c7ft-card span{display:block;margin-top:4px;color:#91a0b8;font-size:11px;line-height:1.35}
        #c7-floor-total-widget .c7ft-card .c7ft-label{font-size:11px;font-weight:900;color:#dce7ff;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}
        #c7-floor-total-widget .c7ft-card.warn b{color:#ff9f43}
        #c7-floor-total-widget .c7ft-card.critical b{color:#ff5c6c}
        #c7-floor-total-widget .c7ft-card.callout b{color:#a879ff}
      `;
      document.head.appendChild(style);
    }

    widget = document.createElement('div');
    widget.id = 'c7-floor-total-widget';
    widget.innerHTML = '<div class="c7ft-title">Total C7 by floor<br><span style="font-weight:600;color:#6f7f99">All dwell</span></div><div class="c7ft-card"><div class="c7ft-label">Waiting</div><b>-</b><span>No Rodeo data yet</span></div>';

    const floorCopyBar = document.querySelector('.floor-copybar');
    const toolbar = document.querySelector('.toolbar');
    const cards = document.querySelector('.cards');
    if (floorCopyBar && floorCopyBar.parentNode) {
      floorCopyBar.parentNode.insertBefore(widget, floorCopyBar);
    } else if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(widget, toolbar.nextSibling);
    } else if (cards && cards.parentNode) {
      cards.parentNode.insertBefore(widget, cards.nextSibling);
    } else {
      document.body.appendChild(widget);
    }
    return widget;
  }

  function floorLabelFromNumber(floor) {
    return ({ '2': 'P2R2', '3': 'P2R3', '4': 'P2R4', Other: 'Other' })[floor] || `P${floor}`;
  }

  function renderFloorTotalsLoading(message = 'Refreshing all C7 floor totals…') {
    const widget = ensureFloorTotalsWidget();
    widget.innerHTML = `<div class="c7ft-title">Total C7 by floor<br><span style="font-weight:600;color:#6f7f99">All dwell</span></div><div class="c7ft-card"><div class="c7ft-label">Loading</div><b>…</b><span>${escapeHTML(message)}</span></div>`;
  }

  function renderFloorTotalsError(message, fallbackShipments = [], fallbackRows = 0) {
    const widget = ensureFloorTotalsWidget();
    const fallback = buildFloorTotals(fallbackShipments || []);
    const fallbackCards = fallback.map(total => `<div class="c7ft-card warn"><div class="c7ft-label">${total.label}</div><b>${total.shipments}</b><span>Fallback: 30m+ dwell only<br>${total.items} row${total.items === 1 ? '' : 's'}</span></div>`).join('');
    widget.innerHTML = `<div class="c7ft-title">Total C7 by floor<br><span style="font-weight:600;color:#ffb86b">All dwell fetch failed</span></div>${fallbackCards}<div class="c7ft-card critical"><div class="c7ft-label">Error</div><b>!</b><span>${escapeHTML(message)}<br>${fallbackRows || 0} fallback source rows</span></div>`;
  }

  function renderAllC7FloorTotalsWidget(summary) {
    const widget = ensureFloorTotalsWidget();
    const floors = summary?.floors || ['2', '3', '4'].map(emptyFloorTotal);
    const sourceLabel = summary?.source === 'exsd-scanned-table' ? 'Rodeo ExSD Scanned table' : 'All dwell / Scanned';
    const cards = floors.map(total => {
      const count = Number(total.total ?? total.items ?? total.shipments ?? 0);
      const detail = summary?.source === 'exsd-scanned-table'
        ? 'Rodeo Scanned total'
        : `${Number(total.items || 0)} C7 row${Number(total.items || 0) === 1 ? '' : 's'}`;
      const qtyText = total.qty ? ` • Qty ${total.qty}` : '';
      const dwellText = total.maxDwell ? ` • Longest ${formatDwell(total.maxDwell)}` : '';
      return `<div class="c7ft-card"><div class="c7ft-label">${escapeHTML(total.label || floorLabelFromNumber(total.floor))}</div><b>${count}</b><span>${detail}${qtyText}<br>All dwell${dwellText}</span></div>`;
    }).join('');
    const grandTotal = Number(summary?.grandTotal ?? summary?.allItems ?? summary?.allShipments ?? 0);
    const allQtyText = summary?.allQty ? ` • Qty ${summary.allQty}` : '';
    const refreshed = summary?.loadedAt ? new Date(summary.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const bottomText = summary?.source === 'exsd-scanned-table'
      ? `No 1000-row cap${refreshed ? ` • ${refreshed}` : ''}`
      : `${Number(summary?.sourceRows || 0)} source rows${refreshed ? ` • ${refreshed}` : ''}`;
    widget.innerHTML = `<div class="c7ft-title">Total C7 by floor<br><span style="font-weight:600;color:#6f7f99">${escapeHTML(sourceLabel)}</span></div>${cards}<div class="c7ft-card"><div class="c7ft-label">All floors</div><b>${grandTotal}</b><span>${grandTotal} C7 total${allQtyText}<br>${bottomText}</span></div>`;
  }

  // Parse Rodeo ExSD summary instead of ItemList rows.
  // The old ItemList method can stop at 1000 rows, but the ExSD Scanned table shows
  // the full Rodeo totals by PPPickToRebin2/3/4.
  function parseExsdScannedFloorTotals(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const bodyText = clean(doc.body?.innerText || '');
    if (/midway|sign in|login|authentication|are you a robot|captcha/i.test(bodyText)) {
      throw new Error('Authentication/CAPTCHA page received. Open Rodeo and complete login first.');
    }

    let table = doc.querySelector('#ScannedTable');
    if (!table) {
      const titles = [...doc.querySelectorAll('span.process-path-title')];
      const scannedTitle = titles.find(span => clean(span.textContent).toLowerCase() === 'scanned');
      table = scannedTitle ? scannedTitle.nextElementSibling?.querySelector?.('table.result-table') || scannedTitle.parentElement?.nextElementSibling?.querySelector?.('table.result-table') || scannedTitle.parentElement?.parentElement?.querySelector?.('table.result-table') : null;
    }
    if (!table) {
      table = [...doc.querySelectorAll('table.result-table')].find(t => /PPPickToRebin[234]/i.test(t.innerText || '') && /Scanned/i.test((t.id || '') + ' ' + (t.previousElementSibling?.innerText || '')));
    }
    if (!table) throw new Error('Rodeo Scanned ExSD table not found. Open the ExSD page and check Rodeo loaded correctly.');

    const rows = [...table.querySelectorAll('tr')];
    const headerRow = rows.find(row => [...row.children].some(cell => /^total$/i.test(clean(cell.textContent))));
    const headerCells = headerRow ? [...headerRow.children] : [];
    let totalIndex = headerCells.findIndex(cell => /^total$/i.test(clean(cell.textContent)));
    if (totalIndex < 0) totalIndex = 1;

    const parseCount = value => {
      const text = clean(value).replace(/,/g, '');
      // v1.5.4 fix: use a plain digit regex. v1.5.3 had a hidden backspace char before \d, so all ExSD totals parsed as 0.
      const match = text.match(/-?\d+/);
      return match ? Number(match[0]) : 0;
    };

    const floors = { '2': emptyFloorTotal('2'), '3': emptyFloorTotal('3'), '4': emptyFloorTotal('4') };
    let grandTotal = 0;
    let matchedFloorRows = 0;

    for (const row of rows) {
      if (row === headerRow) continue;
      const cells = [...row.children];
      if (!cells.length) continue;
      const rowLabel = clean(cells[0]?.textContent || '');
      const value = parseCount(cells[totalIndex]?.textContent || '');

      const floorMatch = rowLabel.match(/PPPickToRebin([234])/i);
      if (floorMatch) {
        const floor = floorMatch[1];
        floors[floor].total = value;
        floors[floor].items = value;
        floors[floor].shipments = value;
        matchedFloorRows += 1;
        continue;
      }

      if (/^total$/i.test(rowLabel)) {
        grandTotal = value;
      }
    }

    if (!matchedFloorRows) throw new Error('Scanned table found, but PPPickToRebin2/3/4 rows were not found.');
    if (!grandTotal) grandTotal = ['2', '3', '4'].reduce((sum, floor) => sum + Number(floors[floor].total || 0), 0);

    const floorList = ['2', '3', '4'].map(floor => ({
      floor,
      label: floorLabelFromNumber(floor),
      total: Number(floors[floor].total || 0),
      items: Number(floors[floor].items || 0),
      shipments: Number(floors[floor].shipments || 0),
      qty: 0,
      maxDwell: 0
    }));

    return {
      source: 'exsd-scanned-table',
      floors: floorList,
      grandTotal,
      allItems: grandTotal,
      allShipments: grandTotal,
      allQty: 0,
      sourceRows: rows.length,
      countedRows: matchedFloorRows,
      loadedAt: Date.now()
    };
  }

  function fetchAllC7FloorTotals(fallbackParsed = null) {
    if (!accessApproved || allC7TotalsRunning) return;
    allC7TotalsRunning = true;
    renderFloorTotalsLoading('Fetching Rodeo ExSD Scanned summary. This avoids the 1000-row ItemList cap.');

    GM_xmlhttpRequest({
      method: 'GET',
      url: EXSD_SCANNED_TOTAL_URL,
      anonymous: false,
      timeout: 45_000,
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      },
      onload: response => {
        try {
          if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);
          if (looksLikeAuthenticationPage(response)) throw new Error('Authentication page received. Open Rodeo and sign in first.');
          const summary = parseExsdScannedFloorTotals(response.responseText);
          renderAllC7FloorTotalsWidget(summary);
        } catch (error) {
          console.error('[Condition 7 Standalone] All C7 floor totals failed:', error);
          renderFloorTotalsError(error.message, fallbackParsed?.shipments || [], fallbackParsed?.sourceRows || 0);
        } finally {
          allC7TotalsRunning = false;
        }
      },
      onerror: () => {
        allC7TotalsRunning = false;
        renderFloorTotalsError('ExSD Scanned totals request failed. Check network, Midway and Rodeo login.', fallbackParsed?.shipments || [], fallbackParsed?.sourceRows || 0);
      },
      ontimeout: () => {
        allC7TotalsRunning = false;
        renderFloorTotalsError('ExSD Scanned totals request timed out.', fallbackParsed?.shipments || [], fallbackParsed?.sourceRows || 0);
      }
    });
  }

  // Backward-compatible renderer name used by older error/clear paths.
  function renderFloorTotalsWidget(shipments, sourceRows = 0) {
    if (!shipments || !shipments.length) {
      const widget = ensureFloorTotalsWidget();
      widget.innerHTML = '<div class="c7ft-title">Total C7 by floor<br><span style="font-weight:600;color:#6f7f99">All dwell</span></div><div class="c7ft-card"><div class="c7ft-label">Waiting</div><b>-</b><span>No ExSD Scanned data yet</span></div>';
      return;
    }
    renderFloorTotalsError('Showing fallback 30m+ dwell data until all-C7 totals load.', shipments, sourceRows);
  }

  /* ----------------------------- Slack support ---------------------------- */

  function slackWebhook() {
    return String(gmGet(STORAGE.slackWebhook, '') || '').trim();
  }

  function slackEnabled() {
    return gmGet(STORAGE.slackEnabled, false) === true;
  }

  function validSlackWebhook(url) {
    return /^https:\/\/hooks\.slack\.com\/(services|triggers)\//i.test(String(url || '').trim());
  }

  function loadSlackSent() {
    try { return JSON.parse(gmGet(STORAGE.slackSentMap, '{}') || '{}') || {}; }
    catch (_) { return {}; }
  }

  function saveSlackSent(map) {
    gmSet(STORAGE.slackSentMap, JSON.stringify(map || {}));
  }

  function sendSlackStatus(message = '', toast = '') {
    emit('condition7-slack-status', {
      configured: validSlackWebhook(slackWebhook()),
      enabled: slackEnabled(),
      message: message || `Webhook configured: ${validSlackWebhook(slackWebhook()) ? 'Yes' : 'No'}. Automatic callout alerts are ${slackEnabled() ? 'enabled' : 'disabled'}.`,
      toast
    });
  }

  function parseDwell(text) {
    text = clean(text).toLowerCase();
    if (!text) return 0;
    const h = text.match(/(\d+(?:\.\d+)?)\s*h/);
    const m = text.match(/(\d+(?:\.\d+)?)\s*m/);
    if (h || m) return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
    const c = text.match(/(\d+):(\d{2})/);
    if (c) return Number(c[1]) * 60 + Number(c[2]);
    const n = text.match(/\d+(?:\.\d+)?/);
    if (!n) return 0;
    return text.includes('.') ? Math.round(Number(n[0]) * 60) : Math.round(Number(n[0]));
  }

  function formatDwell(minutes) {
    const value = Number(minutes) || 0;
    const h = Math.floor(Math.abs(value) / 60);
    const m = Math.abs(value) % 60;
    const sign = value < 0 ? '-' : '';
    return h ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
  }

  function parseDate(text) {
    text = clean(text);
    if (!text) return null;
    let date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
    const match = text.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\s+(\d{1,2}):(\d{2})/);
    if (match) {
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      date = new Date(year, Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]));
      if (!Number.isNaN(date.getTime())) return date;
    }
    return null;
  }

  function shortDate(date) {
    if (!date) return '-';
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function columnMap(table) {
    const map = {};
    table.querySelectorAll('thead th').forEach((th, index) => {
      const name = clean(th.innerText).toLowerCase();
      if (name) map[name] = index;
    });
    return map;
  }

  function idx(map, names) {
    for (const name of names) {
      const key = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    }
    return -1;
  }

  function cell(cells, index) {
    return index >= 0 && cells[index] ? cells[index] : null;
  }

  function txt(cells, index) {
    const element = cell(cells, index);
    return element ? clean(element.innerText) : '';
  }

  function directShipmentUrl(cells, index, shipmentId) {
    const element = cell(cells, index);
    if (element) {
      const exact = [...element.querySelectorAll('a[href]')].find(anchor =>
        /\/warehouse\/NCL1\/shipment\//i.test(anchor.getAttribute('href') || '')
      );
      if (exact) return exact.getAttribute('href');
    }
    return `https://eu.hitch.aft.amazon.dev/warehouse/NCL1/shipment/${encodeURIComponent(shipmentId)}`;
  }

  function parseHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table.result-table');
    if (!table) {
      throw new Error(/midway|sign in|login/i.test(doc.body?.innerText || '')
        ? 'Authentication page received. Open Rodeo and sign in first.'
        : 'Rodeo result table not found.');
    }

    const map = columnMap(table);
    const I = {
      shipment: idx(map, ['Shipment ID']),
      condition: idx(map, ['Condition']),
      expected: idx(map, ['Expected Ship Date']),
      dwell: idx(map, ['Dwell Time', 'Dwell Time (hours)']),
      scannable: idx(map, ['Scannable ID']),
      process: idx(map, ['Process Path']),
      qty: idx(map, ['Quantity']),
      fnsku: idx(map, ['FN SKU']),
      title: idx(map, ['Title', 'ASIN Title', 'ASIN Titles']),
      outer: idx(map, ['Outer Scannable ID'])
    };

    const missing = [
      ['Shipment ID', I.shipment],
      ['Condition', I.condition],
      ['Expected Ship Date', I.expected],
      ['Dwell Time', I.dwell],
      ['Scannable ID', I.scannable],
      ['Outer Scannable ID', I.outer]
    ].filter(([, index]) => index < 0).map(([name]) => name);

    if (missing.length) throw new Error(`Missing Rodeo columns: ${missing.join(', ')}`);

    const groups = new Map();
    const now = Date.now();
    const rows = [...table.querySelectorAll('tbody tr')];

    for (const row of rows) {
      const cells = [...row.children];
      if (!cells.length) continue;
      const condition = Number(txt(cells, I.condition));
      if (condition !== 7) continue;

      const shipmentId = normalizeShipmentId(txt(cells, I.shipment)) || 'Unknown';
      const expectedText = txt(cells, I.expected);
      const expectedDate = parseDate(expectedText);
      const cptDate = expectedDate ? new Date(expectedDate.getTime() - CPT_OFFSET_MIN * 60_000) : null;
      const minutesToShip = expectedDate ? Math.round((expectedDate.getTime() - now) / 60_000) : null;
      const dwellText = txt(cells, I.dwell);
      const dwell = parseDwell(dwellText);
      const processPath = txt(cells, I.process);
      const floor = (processPath.match(/PPPickToRebin([234])/i) || [])[1] || 'Other';
      const outerScannableId = txt(cells, I.outer) || '-';

      const item = {
        scannableId: txt(cells, I.scannable),
        outerScannableId,
        processPath,
        qty: Number(txt(cells, I.qty)) || 0,
        fnsku: txt(cells, I.fnsku),
        title: txt(cells, I.title),
        dwell,
        dwellText,
        floor
      };

      if (!groups.has(shipmentId)) {
        groups.set(shipmentId, {
          shipmentId,
          shipmentUrl: directShipmentUrl(cells, I.shipment, shipmentId),
          items: [],
          totalQty: 0,
          maxDwell: 0,
          maxDwellText: '',
          expectedText,
          cptText: shortDate(cptDate),
          minutesToShip,
          calloutRisk: minutesToShip !== null && minutesToShip <= SHIP_CALLOUT_MIN,
          processPaths: new Set(),
          floors: new Set()
        });
      }

      const group = groups.get(shipmentId);
      group.items.push(item);
      group.totalQty += item.qty;
      if (dwell >= group.maxDwell) {
        group.maxDwell = dwell;
        group.maxDwellText = dwellText || formatDwell(dwell);
      }
      if (item.processPath) group.processPaths.add(item.processPath);
      if (item.floor) group.floors.add(item.floor);
      if (minutesToShip !== null && (group.minutesToShip === null || minutesToShip < group.minutesToShip)) {
        group.minutesToShip = minutesToShip;
        group.expectedText = expectedText;
        group.cptText = shortDate(cptDate);
      }
      group.calloutRisk = group.calloutRisk || (minutesToShip !== null && minutesToShip <= SHIP_CALLOUT_MIN);
    }

    const shipments = [...groups.values()]
      .map(group => ({
        ...group,
        processPaths: [...group.processPaths],
        floors: [...group.floors]
      }))
      .sort((a, b) => Number(b.calloutRisk) - Number(a.calloutRisk) || b.maxDwell - a.maxDwell);

    return { shipments, sourceRows: rows.length, verifiedLogin: currentLogin, floorTotals: buildFloorTotals(shipments) };
  }

  function slackKey(shipment) {
    return `${shipment.shipmentId}|${shipment.expectedText || ''}`;
  }

  function slackText(shipment, testMode = false) {
    if (testMode) return '🧪 Condition 7 Slack test from the standalone NCL1 dashboard. Slack alerts are configured correctly.';
    const pairs = [...new Set((shipment.items || []).map(item => `${item.scannableId || '-'} / ${item.outerScannableId || '-'}`))].join('\n');
    return [
      '🚨 *Condition 7 Callout Risk - NCL1*',
      `*Shipment:* <${shipment.shipmentUrl}|${shipment.shipmentId}>`,
      `*Expected Ship Date:* ${shipment.expectedText || '-'}`,
      `*Scannable / Outer:*\n${pairs || '-'}`,
      `*Dwell Time:* ${formatDwell(shipment.maxDwell)}`,
      `*Ship time remaining:* ${formatDwell(shipment.minutesToShip)}`
    ].join('\n');
  }

  function slackPayload(shipment, testMode = false) {
    if (testMode) return { text: slackText(null, true), severity: 'TEST', site: 'NCL1' };
    const scannables = [...new Set((shipment.items || []).map(item => item.scannableId).filter(Boolean))].join(', ');
    const outers = [...new Set((shipment.items || []).map(item => item.outerScannableId).filter(Boolean))].join(', ');
    return {
      text: slackText(shipment, false),
      severity: 'CALL_OUT_RISK',
      site: 'NCL1',
      shipment: shipment.shipmentId,
      shipment_url: shipment.shipmentUrl,
      expected_ship: shipment.expectedText || '-',
      scannable: scannables || '-',
      outer_scannable: outers || '-',
      dwell: formatDwell(shipment.maxDwell),
      ship_left: formatDwell(shipment.minutesToShip)
    };
  }

  function postSlack(payload, overrideWebhook = '') {
    const webhook = String(overrideWebhook || slackWebhook()).trim();
    return new Promise((resolve, reject) => {
      if (!validSlackWebhook(webhook)) {
        reject(new Error('Slack webhook is not configured'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: webhook,
        anonymous: false,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: 20_000,
        onload: response => response.status >= 200 && response.status < 300
          ? resolve(response)
          : reject(new Error(`Slack HTTP ${response.status}: ${response.responseText || 'No response'}`)),
        onerror: () => reject(new Error('Slack network request failed')),
        ontimeout: () => reject(new Error('Slack request timed out'))
      });
    });
  }

  function consolidateCalloutShipments(shipments) {
    const grouped = new Map();
    for (const original of shipments || []) {
      if (!original?.calloutRisk) continue;
      const shipmentId = normalizeShipmentId(original.shipmentId) || 'Unknown';
      if (!grouped.has(shipmentId)) {
        grouped.set(shipmentId, { ...original, shipmentId, items: [...(original.items || [])] });
        continue;
      }
      const current = grouped.get(shipmentId);
      current.items.push(...(original.items || []));
      if (Number(original.maxDwell || 0) > Number(current.maxDwell || 0)) {
        current.maxDwell = original.maxDwell;
        current.maxDwellText = original.maxDwellText;
      }
      if (current.minutesToShip == null || (original.minutesToShip != null && original.minutesToShip < current.minutesToShip)) {
        current.minutesToShip = original.minutesToShip;
        current.expectedText = original.expectedText;
        current.shipmentUrl = original.shipmentUrl || current.shipmentUrl;
      }
    }

    for (const shipment of grouped.values()) {
      const seen = new Set();
      shipment.items = shipment.items.filter(item => {
        const key = `${clean(item.scannableId)}|${clean(item.outerScannableId)}|${clean(item.fnsku)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return [...grouped.values()];
  }

  function processSlackAlerts(shipments) {
    if (!accessApproved || !slackEnabled() || !validSlackWebhook(slackWebhook())) return;

    const now = Date.now();
    const sent = loadSlackSent();
    Object.keys(sent).forEach(key => {
      if (now - Number(sent[key] || 0) > SLACK_MEMORY_HOURS * 3_600_000) delete sent[key];
    });
    saveSlackSent(sent);

    const callouts = consolidateCalloutShipments(shipments);
    let started = 0;

    for (const shipment of callouts) {
      if (started >= SLACK_MAX_PER_REFRESH) break;
      const key = slackKey(shipment);
      if (sent[key] || slackPending.has(key)) continue;

      const reservationTime = Date.now();
      const latest = loadSlackSent();
      if (latest[key]) continue;
      latest[key] = reservationTime;
      saveSlackSent(latest);

      slackPending.add(key);
      started += 1;

      postSlack(slackPayload(shipment, false))
        .then(() => {
          const current = loadSlackSent();
          current[key] = Date.now();
          saveSlackSent(current);
          sendSlackStatus(`Slack alert sent for shipment ${shipment.shipmentId}`, `Slack alert sent: ${shipment.shipmentId}`);
        })
        .catch(error => {
          const current = loadSlackSent();
          if (Number(current[key] || 0) === reservationTime) {
            delete current[key];
            saveSlackSent(current);
          }
          console.error('[Condition 7 Standalone] Slack failed:', error);
          sendSlackStatus(`Slack alert failed: ${error.message}`, 'Slack alert failed');
        })
        .finally(() => slackPending.delete(key));
    }
  }

  /* ----------------------------- Rodeo refresh ---------------------------- */

  function fetchNow() {
    if (!accessApproved) {
      sendAccess('checking', { message: 'Access must be verified before Rodeo data can load.' });
      verifyAccess(true);
      return;
    }
    if (paused || running) return;

    running = true;
    sendStatus('Refreshing Rodeo data…', `Verified user: ${currentLogin}`);

    GM_xmlhttpRequest({
      method: 'GET',
      url: TARGET_URL,
      anonymous: false,
      timeout: 45_000,
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      },
      onload: response => {
        try {
          if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);
          const parsed = parseHTML(response.responseText);
          sendData(parsed);
          fetchAllC7FloorTotals(parsed);
          processSlackAlerts(parsed.shipments);
        } catch (error) {
          sendStatus('Unable to read Rodeo data', error.message, 'error');
        } finally {
          running = false;
        }
      },
      onerror: () => {
        running = false;
        sendStatus('Rodeo request failed', 'Check the network, Midway and Rodeo login', 'error');
      },
      ontimeout: () => {
        running = false;
        sendStatus('Rodeo request timed out', 'Try again after opening Rodeo in another tab', 'error');
      }
    });
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(fetchNow, REFRESH_MS);
  }

  function scheduleAccessRecheck() {
    clearInterval(accessTimer);
    accessTimer = setInterval(() => verifyAccess(true), ACCESS_RECHECK_MS);
  }

  function startMonitoring() {
    if (!dashboardReady || !accessApproved) return;
    sendStatus('Helper connected', `Flow ✅ • Firebase ✅ • Rodeo refresh every 60 seconds • signed in as ${currentLogin}`);
    sendSlackStatus();
    fetchNow();
    scheduleRefresh();
    scheduleAccessRecheck();
  }

  /* ---------------------------- Dashboard commands ----------------------- */

  document.addEventListener('condition7-command', event => {
    const detail = event.detail || {};
    const action = detail.action;

    if (action === 'access-status') {
      sendHelperPong(detail.requestId || '');
      if (accessRequestRunning) {
        sendAccess('checking', { message: 'Checking Flow/Firebase access…', detail: 'The helper will try background Flow verification first using cache-safe /permissions handling. If it fails, use Verify Amazon Login.', actions: [] });
      } else if (accessApproved) {
        sendAccess('approved', { login: currentLogin, message: `Access approved for ${currentLogin}` });
      } else {
        verifyAccess(true);
      }
      return;
    }

    if (action === 'access-retry') {
      verifyAccess(true);
      return;
    }

    if (!accessApproved) {
      sendAccess('denied', {
        login: currentLogin,
        message: 'Dashboard is locked',
        detail: 'Access verification must pass before this action is available.'
      });
      return;
    }

    if (action === 'refresh') fetchNow();
    if (action === 'pause') {
      paused = true;
      sendStatus('Paused', 'Background refresh is stopped');
    }
    if (action === 'resume') {
      paused = false;
      sendStatus('Resumed', `Signed in as ${currentLogin} • refreshing every 60 seconds`);
      fetchNow();
    }
    if (action === 'slack-status') sendSlackStatus();

    if (action === 'slack-save') {
      const supplied = String(detail.webhook || '').trim();
      if (supplied && !validSlackWebhook(supplied)) {
        sendSlackStatus('Invalid Slack webhook URL', 'Invalid Slack webhook');
        return;
      }
      if (supplied) gmSet(STORAGE.slackWebhook, supplied);
      gmSet(STORAGE.slackEnabled, Boolean(detail.enabled));
      sendSlackStatus('Slack settings saved', `Slack alerts ${detail.enabled ? 'enabled' : 'disabled'}`);
    }

    if (action === 'slack-test') {
      const supplied = String(detail.webhook || '').trim();
      if (supplied && !validSlackWebhook(supplied)) {
        sendSlackStatus('Invalid Slack webhook URL', 'Invalid Slack webhook');
        return;
      }
      if (supplied) gmSet(STORAGE.slackWebhook, supplied);
      postSlack(slackPayload(null, true), supplied)
        .then(() => sendSlackStatus('Slack test sent successfully', 'Slack test sent'))
        .catch(error => sendSlackStatus(`Slack test failed: ${error.message}`, 'Slack test failed'));
    }

    if (action === 'slack-clear-history') {
      saveSlackSent({});
      sendSlackStatus('Slack alert history reset. Current callouts may alert again on the next refresh.', 'Slack history reset');
    }
  });

  document.addEventListener('condition7-dashboard-ready', () => {
    dashboardReady = true;
    sendHelperPong('dashboard-ready');
    sendSlackStatus();
    verifyAccess(true);
  });

  // Announce the helper immediately; the page will also ping repeatedly in case
  // this event fires before its own listener is attached.
  sendHelperPong('startup');
  sendAccess('checking', { message: 'Checking Flow/Firebase access…', detail: 'The helper will try background Flow verification first using cache-safe /permissions handling. If it fails, use Verify Amazon Login.', actions: [] });


  // ===== Prince Jacob Custom Update Checker - Every 10 Hours =====
  function princeUpdateChecker() {
    const UPDATE_URL = 'https://raw.githubusercontent.com/prince-jacob/c7_dwell_monitor/main/Condition%207%20Dashboard.user.js';
    const CHECK_KEY = 'prince_last_update_check_' + ((typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.name) ? GM_info.script.name : 'Condition7DashboardHelper');
    const CHECK_INTERVAL = 10 * 60 * 60 * 1000; // 10 hours

    const lastCheck = Number(gmGet(CHECK_KEY, 0));
    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL) return;
    gmSet(CHECK_KEY, now);

    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE_URL,
      nocache: true,
      timeout: 20_000,
      onload: response => {
        const remoteScript = String(response.responseText || '');
        const remoteMatch = remoteScript.match(/\/\/\s*@version\s+([0-9.]+)/i);
        if (!remoteMatch) {
          console.log('[Condition 7 Update Checker] Remote version not found.');
          return;
        }

        const remoteVersion = remoteMatch[1];
        const currentVersion = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : HELPER_VERSION;
        if (isNewerVersion(remoteVersion, currentVersion)) {
          const openUpdate = window.confirm(
            'New Condition 7 Dashboard update available!\n\n' +
            'Current version: ' + currentVersion + '\n' +
            'New version: ' + remoteVersion + '\n\n' +
            'Open update page now?'
          );
          if (openUpdate) window.open(UPDATE_URL, '_blank', 'noopener,noreferrer');
        } else {
          console.log('[Condition 7 Update Checker] Up to date:', currentVersion);
        }
      },
      onerror: () => console.log('[Condition 7 Update Checker] Failed to check update.'),
      ontimeout: () => console.log('[Condition 7 Update Checker] Update check timed out.')
    });

    function isNewerVersion(remote, current) {
      const r = String(remote).split('.').map(Number);
      const c = String(current).split('.').map(Number);
      const len = Math.max(r.length, c.length);
      for (let i = 0; i < len; i += 1) {
        const rv = r[i] || 0;
        const cv = c[i] || 0;
        if (rv > cv) return true;
        if (rv < cv) return false;
      }
      return false;
    }
  }

  princeUpdateChecker();

  // Fallback for local/hosted pages that dispatched their ready event before
  // Tampermonkey finished injecting this helper.
  setTimeout(() => {
    dashboardReady = true;
    sendHelperPong('fallback');
    verifyAccess(true);
  }, 600);
})();
