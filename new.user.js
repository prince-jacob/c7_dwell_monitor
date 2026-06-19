// ==UserScript==
// @name         Condition 7 Standalone Dashboard Helper - NCL1
// @namespace    wprijaco.condition7.standalone.helper
// @version      1.4.0
// @description  Access-controlled standalone Condition 7 dashboard helper with Flow Sortation login verification, background Rodeo refresh, and optional Slack callout alerts.
// @author       Prince Jacob (Wprijaco)
// @updateURL    https://raw.githubusercontent.com/prince-jacob/c7_dwell_monitor/main/Condition%207%20Dashboard.user.js
// @downloadURL  https://raw.githubusercontent.com/prince-jacob/c7_dwell_monitor/main/Condition%207%20Dashboard.user.js
// @match        file:///*
// @match        https://p2rc7dwell.thejacobslab.com/*
// @connect      flow-sortation-eu.amazon.com
// @connect      rodeo-dub.amazon.com
// @connect      hooks.slack.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DASHBOARD_MARKER = 'meta[name="condition7-dashboard"][content="wprijaco-v1"]';
  if (!document.querySelector(DASHBOARD_MARKER)) return;

  const HELPER_VERSION = '1.4.0';
  const INSTANCE_ATTRIBUTE = 'data-condition7-helper-active';

  if (document.documentElement.hasAttribute(INSTANCE_ATTRIBUTE)) {
    console.warn('[Condition 7 Standalone] Another helper instance is already active. This copy will stop.');
    return;
  }
  document.documentElement.setAttribute(INSTANCE_ATTRIBUTE, HELPER_VERSION);

  /* Add or remove approved Amazon aliases here. Always use lowercase. */
  const ALLOWED_USERS = Object.freeze([
    'wprijaco'
  ]);

  const REFRESH_MS = 60_000;
  const ACCESS_RECHECK_MS = 15 * 60_000;
  const CPT_OFFSET_MIN = 60;
  const SHIP_CALLOUT_MIN = 45;
  const SLACK_MAX_PER_REFRESH = 5;
  const SLACK_MEMORY_HOURS = 12;

  const FLOW_IDENTITY_URL = 'https://flow-sortation-eu.amazon.com/NCL1/';
  const TARGET_URL = 'http://rodeo-dub.amazon.com/NCL1/ItemList?_enabledColumns=on&enabledColumns=OUTER_SCANNABLE_ID&enabledColumns=ASIN_TITLES&WorkPool=Scanned&Fracs=NON_FRACS&DwellTimeGreaterThan=0.5&DwellTimeLessThan=2.1333333333333333&ProcessPath=PPPickToRebin4%2cPPPickToRebin2%2cPPPickToRebin3&shipmentType=CUSTOMER_SHIPMENTS';

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
  let dashboardReady = false;

  const slackPending = new Set();
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

  function emit(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
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
    emit('condition7-access', {
      state,
      login: options.login || currentLogin || '',
      message: options.message || '',
      detail: options.detail || '',
      helperVersion: HELPER_VERSION,
      allowedUsersCount: ALLOWED_USERS.length
    });
  }

  document.addEventListener('condition7-helper-ping', event => {
    sendHelperPong(event.detail?.requestId || '');
  });

  /* ---------------------------- Access control ---------------------------- */

  function extractAmazonLogin(htmlText) {
    const html = String(htmlText || '');
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const element of doc.querySelectorAll('[data-ng-init]')) {
      const initText = element.getAttribute('data-ng-init') || '';
      const match = initText.match(/(?:^|[;\s])username\s*=\s*['"]([^'"]+)['"]/i);
      if (match?.[1]) return normalizeLogin(match[1]);
    }

    const rawMatch = html.match(/username\s*=\s*(?:&quot;|&#34;|['"])([a-z0-9._-]+)(?:&quot;|&#34;|['"])/i);
    if (rawMatch?.[1]) return normalizeLogin(rawMatch[1]);

    const pageText = clean(doc.body?.textContent || '');
    const welcomeMatch = pageText.match(/Welcome,\s*([a-z0-9._-]+)/i);
    if (welcomeMatch?.[1]) return normalizeLogin(welcomeMatch[1]);

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
    if (clearDashboard) sendData({ shipments: [], sourceRows: 0, accessRevoked: true });
  }

  function verifyAccess(force = false) {
    if (accessRequestRunning) return;
    if (!force && accessApproved && currentLogin) {
      sendAccess('approved', {
        login: currentLogin,
        message: `Access approved for ${currentLogin}`
      });
      return;
    }

    accessRequestRunning = true;
    sendAccess('checking', {
      message: 'Checking the logged-in Amazon user…',
      detail: 'Verifying your Flow Sortation session'
    });
    sendStatus('Verifying access…', 'Checking the logged-in Flow Sortation user');

    GM_xmlhttpRequest({
      method: 'GET',
      url: FLOW_IDENTITY_URL,
      timeout: 30_000,
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      },
      onload: response => {
        accessRequestRunning = false;

        if (response.status === 401 || response.status === 403 || looksLikeAuthenticationPage(response)) {
          accessApproved = false;
          currentLogin = '';
          stopMonitoring(true);
          sendAccess('login-required', {
            message: 'Amazon sign-in required',
            detail: 'Open Flow Sortation, complete Midway sign-in, then press Retry.'
          });
          sendStatus('Amazon sign-in required', 'Open Flow Sortation and sign in, then retry', 'error');
          return;
        }

        if (response.status < 200 || response.status >= 400) {
          accessApproved = false;
          currentLogin = '';
          stopMonitoring(true);
          sendAccess('error', {
            message: 'Unable to verify access',
            detail: `Flow Sortation returned HTTP ${response.status}`
          });
          sendStatus('Access check failed', `Flow Sortation HTTP ${response.status}`, 'error');
          return;
        }

        const login = extractAmazonLogin(response.responseText);
        if (!login) {
          accessApproved = false;
          currentLogin = '';
          stopMonitoring(true);
          sendAccess('error', {
            message: 'Amazon login could not be identified',
            detail: 'The Flow Sortation page loaded, but its username field was not found.'
          });
          sendStatus('Unable to identify Amazon login', 'Flow Sortation page format may have changed', 'error');
          return;
        }

        currentLogin = login;
        if (!ALLOWED_USERS.includes(login)) {
          accessApproved = false;
          stopMonitoring(true);
          sendAccess('denied', {
            login,
            message: 'Access denied',
            detail: `${login} is not authorised to use this dashboard.`
          });
          sendStatus('Access denied', `${login} is not an approved user`, 'error');
          return;
        }

        accessApproved = true;
        sendAccess('approved', {
          login,
          message: `Access approved for ${login}`,
          detail: 'The dashboard is now connected.'
        });
        sendStatus('Access approved', `Signed in as ${login}`);
        startMonitoring();
      },
      onerror: () => {
        accessRequestRunning = false;
        accessApproved = false;
        currentLogin = '';
        stopMonitoring(true);
        sendAccess('error', {
          message: 'Access verification failed',
          detail: 'Flow Sortation could not be reached from the helper.'
        });
        sendStatus('Access verification failed', 'Check the network and Flow Sortation access', 'error');
      },
      ontimeout: () => {
        accessRequestRunning = false;
        accessApproved = false;
        currentLogin = '';
        stopMonitoring(true);
        sendAccess('error', {
          message: 'Access verification timed out',
          detail: 'Open Flow Sortation in another tab and try again.'
        });
        sendStatus('Access verification timed out', 'Open Flow Sortation and retry', 'error');
      }
    });
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

    return { shipments, sourceRows: rows.length, verifiedLogin: currentLogin };
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
    sendStatus('Helper connected', `Signed in as ${currentLogin} • refreshing every 60 seconds`);
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
        sendAccess('checking', { message: 'Checking the logged-in Amazon user…' });
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
  sendAccess('checking', { message: 'Checking the logged-in Amazon user…' });

  // Fallback for local/hosted pages that dispatched their ready event before
  // Tampermonkey finished injecting this helper.
  setTimeout(() => {
    dashboardReady = true;
    sendHelperPong('fallback');
    verifyAccess(true);
  }, 600);
})();
