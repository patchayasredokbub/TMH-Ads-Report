/**
 * TMH Ads Report — Google Apps Script web app
 * Serves the dashboard (Index.html) and does all data work on the server:
 *   - Meta Marketing API (both ad accounts) with your System User token
 *   - CRM + Regis&Connect Google Sheets (read as you)
 *   - a ledger spreadsheet that remembers every SR / asset / connect ever seen (never removes, never double counts)
 *
 * Script properties (Project Settings → Script properties):
 *   META_TOKEN       System User access token with ads_read on both ad accounts   (required)
 *   LEDGER_SHEET_ID  id of the Google Sheet that holds the ledger                  (required)
 *   META_API_VERSION Graph API version, e.g. v26.0                                  (optional)
 */

const AD_ACCOUNTS = ['1093811509479768', '983107730972192'];
const CRM_SHEET_ID = '1Vj3tYDCtuoVDgKq0B5FoQZ9EoxsujrQ6xBBTaBMQHjo';
const REGIS_SHEET_ID = '1fbSGCShZfoOpAs5nwj4o1FEtzy9EsZEYl6oLXCXuu0o';
const CRM_PAGES = { 'ทรูภาคใต้': '694326127098793', 'เน็ตบ้านทรูฯ สมัครง่าย': '993241830549021' };
const CRM_START = '2026-10-01';
const MSG_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
const MSG = 'actions:' + MSG_ACTION;              // field names the page expects
const CPR = 'cost_per_action_type:' + MSG_ACTION;
const TZ = 'Asia/Bangkok';

/* ======================= web app ======================= */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('TMH Ads Report')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/* ======================= helpers ======================= */
const P = () => PropertiesService.getScriptProperties();
function prop(k, req) { const v = P().getProperty(k); if (req && !v) throw new Error('ยังไม่ได้ตั้งค่า Script property: ' + k); return v; }
function today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function bkkDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim(); const t = Date.parse(s);
  if (isNaN(t)) return s.slice(0, 10);
  return new Date(t + 7 * 3600000).toISOString().slice(0, 10);
}
function ymd(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim(); if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); return s.slice(0, 10);
}
/* same hash the Claude dashboard used: SHA-256 of the trimmed number, first 8 bytes in hex */
function h16(s) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s).trim(), Utilities.Charset.UTF_8);
  return b.slice(0, 8).map(x => ((x + 256) % 256).toString(16).padStart(2, '0')).join('');
}
function cacheGet(key) {
  const c = CacheService.getScriptCache(), head = c.get(key); if (!head) return null;
  const n = +head; if (!n) return null;
  const parts = c.getAll(Array.from({ length: n }, (_, i) => key + ':' + i));
  let s = ''; for (let i = 0; i < n; i++) { const p = parts[key + ':' + i]; if (p == null) return null; s += p; }
  try { return JSON.parse(s); } catch (e) { return null; }
}
function cachePut(key, obj, secs) {
  const c = CacheService.getScriptCache(), s = JSON.stringify(obj), size = 90000, n = Math.ceil(s.length / size) || 1, m = {};
  for (let i = 0; i < n; i++) m[key + ':' + i] = s.slice(i * size, (i + 1) * size);
  try { c.putAll(m, secs); c.put(key, String(n), secs); } catch (e) { /* too big for cache: skip */ }
}

/* ======================= Meta Graph API ======================= */
function apiVersion() { return prop('META_API_VERSION') || 'v26.0'; }
/* one request at a time, with pauses: Apps Script limits how fast a script may call the same host */
function fetchSlow(url) {
  let last = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    let res = null;
    try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); }
    catch (e) { last = 'Google: ' + String(e.message || e).slice(0, 160); Utilities.sleep(2000 * Math.pow(2, attempt)); continue; }
    let body = {}; try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { }
    const code = res.getResponseCode(), err = body.error || {};
    const throttled = [4, 17, 32, 613].indexOf(err.code) >= 0 || (err.code >= 80000 && err.code < 81000) || err.is_transient;
    if (code >= 500 || throttled) {
      /* Meta says how long to wait in this header */
      let wait = '';
      try { const u = JSON.parse(res.getHeaders()['x-business-use-case-usage'] || res.getHeaders()['X-Business-Use-Case-Usage'] || '{}');
        Object.keys(u).forEach(k => (u[k] || []).forEach(x => { if (x.estimated_time_to_regain_access) wait = ' (Meta ให้รอประมาณ ' + x.estimated_time_to_regain_access + ' นาที)'; })); } catch (e) { }
      last = 'Meta #' + (err.code || code) + (err.error_subcode ? '/' + err.error_subcode : '') + ': ' + String(err.message || '').slice(0, 160) + wait;
      if (wait) break;                                  // a long block: retrying now only makes it longer
      Utilities.sleep(3000 * Math.pow(2, attempt)); continue;
    }
    Utilities.sleep(300);
    return body;
  }
  throw new Error('ถูกจำกัดจำนวนครั้งชั่วคราว — ' + last + ' · รอแล้วค่อยกด Refresh อีกครั้ง');
}
function graph(path, params) {
  const v = apiVersion();
  const q = Object.assign({}, params || {}, { access_token: prop('META_TOKEN', true) });
  let url = 'https://graph.facebook.com/' + v + '/' + path + '?' +
    Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(typeof q[k] === 'string' ? q[k] : JSON.stringify(q[k]))).join('&');
  const out = [];
  for (let page = 0; url && page < 50; page++) {
    const body = fetchSlow(url);
    if (body.error) throw new Error('Meta: ' + (body.error.error_user_msg || body.error.message));
    if (!Array.isArray(body.data)) return body;           // a single object
    out.push.apply(out, body.data);
    url = body.paging && body.paging.next;
  }
  return out;
}
function actionVal(list, type) { const a = (list || []).find(x => x.action_type === type); return a ? +a.value : 0; }
/* insights row → the field names the dashboard reads */
function shape(r) {
  const spend = +r.spend || 0, impr = +r.impressions || 0, reach = r.reach != null ? +r.reach : null,
    link = actionVal(r.actions, 'link_click') || +r.inline_link_clicks || 0, clicks = +r.clicks || 0, res = actionVal(r.actions, MSG_ACTION);
  const o = { amount_spent: spend, impressions: impr, reach: reach, link_click: link, clicks: clicks,
    cpm: impr ? spend / impr * 1000 : null, cpp: reach ? spend / reach * 1000 : null,
    cost_per_link_click: link ? spend / link : null, ctr: impr ? clicks / impr * 100 : null };
  o[MSG] = res; o[CPR] = res ? spend / res : null;
  return o;
}
const ID_FIELD = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const INS_FIELDS = 'spend,impressions,reach,clicks,inline_link_clicks,actions';
function insights(acct, level, range, daily) {
  const params = { level: level, fields: 'campaign_id,adset_id,ad_id,' + INS_FIELDS, limit: 500,
    filtering: [{ field: 'spend', operator: 'GREATER_THAN', value: 0 }] };
  if (range.preset) params.date_preset = range.preset; else params.time_range = { since: range.since, until: range.until };
  if (daily) params.time_increment = 1;
  return graph('act_' + acct + '/insights', params).map(r => {
    const o = shape(r); o.id = r[ID_FIELD[level]]; o.campaign_id = r.campaign_id; o.adset_id = r.adset_id; if (daily) o.date_start = r.date_start; return o;
  });
}
function accountInsights(acct, range) {
  const params = { fields: INS_FIELDS };
  if (range.preset) params.date_preset = range.preset; else params.time_range = { since: range.since, until: range.until };
  const rows = graph('act_' + acct + '/insights', params);
  return rows[0] ? shape(rows[0]) : null;
}
const ATTR_FIELDS = {
  campaign: 'name,effective_status,start_time,stop_time',
  adset: 'name,effective_status,campaign_id,start_time,end_time',
  ad: 'name,effective_status,adset_id,campaign_id,created_time,creative{effective_object_story_id,object_story_id}'
};
/* names, status, schedule and page for a list of ids: read from the account's campaign / ad set / ad lists,
   filtered to those ids (100 per request, one request at a time), cached 30 min */
const EDGE = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' };
const ALL_STATUS = ['ACTIVE', 'PAUSED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO',
  'CAMPAIGN_PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'];
function attributes(acct, level, ids, refresh) {
  const out = {}, need = [];
  ids.forEach(id => { const c = !refresh && cacheGet('attr:' + id); if (c) out[id] = c; else need.push(id); });
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    let rows = [];
    try {
      rows = graph('act_' + acct + '/' + EDGE[level], { fields: 'id,' + ATTR_FIELDS[level], limit: 100,
        filtering: [{ field: 'id', operator: 'IN', value: chunk }, { field: 'effective_status', operator: 'IN', value: ALL_STATUS }] });
    } catch (e) { if (/ถูกจำกัดจำนวนครั้ง/.test(e.message)) throw e; /* otherwise keep ids and numbers from insights */ }
    rows.forEach(r => {
      const a = { name: r.name, effective_status: r.effective_status, start_time: r.start_time, stop_time: r.stop_time,
        end_time: r.end_time, campaign_id: r.campaign_id, adset_id: r.adset_id, created_time: r.created_time };
      const sid = r.creative && (r.creative.effective_object_story_id || r.creative.object_story_id);
      if (sid) a.page = String(sid).split('_')[0];
      Object.keys(a).forEach(k => a[k] === undefined && delete a[k]);
      out[String(r.id)] = a; cachePut('attr:' + r.id, a, 1800);
    });
  }
  return out;
}
function pageNames(ids) {
  const known = JSON.parse(prop('PAGE_NAMES') || '{}'); let changed = false;
  ids.forEach(id => {
    if (known[id]) return;
    try { const r = graph(id, { fields: 'name' }); if (r && r.name) { known[id] = r.name; changed = true; } } catch (e) { /* no access to this page */ }
  });
  if (changed) P().setProperty('PAGE_NAMES', JSON.stringify(known));
  return known;
}

/* ---- daily rows live in the ledger spreadsheet, one tab per account; only new days are fetched ---- */
const DAILY_HEAD = ['level', 'id', 'date', 'spend', 'impr', 'reach', 'link', 'clicks', 'res'];
function ledgerBook() { return SpreadsheetApp.openById(prop('LEDGER_SHEET_ID', true)); }
function tab(book, name, head) {
  let sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]); sh.setFrozenRows(1); }
  return sh;
}
function readRows(sh) { const n = sh.getLastRow(); return n < 2 ? [] : sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues(); }
function writeRows(sh, head, rows) {
  sh.clearContents(); sh.getRange(1, 1, 1, head.length).setValues([head]);
  /* plain text, so 18-digit ad ids and dates are stored exactly as written */
  if (rows.length) { const r = sh.getRange(2, 1, rows.length, head.length); r.setNumberFormat('@'); r.setValues(rows.map(x => x.map(v => v === '' || v == null ? '' : String(v)))); }
}
function ensureDaily(acct, since, until, refresh) {
  const pk = 'daily:' + acct, cov = JSON.parse(prop(pk) || 'null'), t = today();
  const fetch = [];
  if (!cov) fetch.push([since, until]);
  else {
    if (since < cov.from) fetch.push([since, addDays(cov.from, -1)]);
    /* re-read from the day before the last pull: Meta may still adjust yesterday */
    if (refresh || until > cov.to) { const a = addDays(cov.to, -1) > since ? addDays(cov.to, -1) : since; if (a <= until) fetch.push([a, until]); }
  }
  if (!fetch.length) return;
  const fresh = [];
  /* only ad-level days come from Meta; ad set and campaign days are their ads added up (reach is then a sum of ads) */
  fetch.forEach(([a, b]) => {
    const groups = {};
    insights(acct, 'ad', { since: a, until: b }, true).forEach(r => {
      fresh.push(['ad', String(r.id), r.date_start, r.amount_spent, r.impressions, r.reach == null ? '' : r.reach, r.link_click, r.clicks, r[MSG]]);
      [['adset', r.adset_id], ['campaign', r.campaign_id]].forEach(([lvl, id]) => {
        if (!id) return; const k = lvl + '|' + id + '|' + r.date_start;
        const g = groups[k] || (groups[k] = [lvl, String(id), r.date_start, 0, 0, 0, 0, 0, 0]);
        g[3] += r.amount_spent; g[4] += r.impressions; g[5] += r.reach || 0; g[6] += r.link_click; g[7] += r.clicks; g[8] += r[MSG];
      });
    });
    Object.keys(groups).forEach(k => fresh.push(groups[k]));
  });
  const lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    const sh = tab(ledgerBook(), 'daily_' + acct, DAILY_HEAD);
    const inFetched = d => fetch.some(([a, b]) => d >= a && d <= b);
    const keep = readRows(sh).filter(r => !inFetched(ymd(r[2]))).map(r => { r[2] = ymd(r[2]); return r; });
    writeRows(sh, DAILY_HEAD, keep.concat(fresh));
    const from = cov ? (since < cov.from ? since : cov.from) : since, to = cov ? (until > cov.to ? until : cov.to) : until;
    P().setProperty(pk, JSON.stringify({ from: from, to: to > t ? t : to }));
  } finally { lock.releaseLock(); }
}
function readDaily(acct, since, until) {
  const sh = ledgerBook().getSheetByName('daily_' + acct); if (!sh) return { campaign: [], adset: [], ad: [] };
  const out = { campaign: [], adset: [], ad: [] };
  readRows(sh).forEach(r => {
    const d = ymd(r[2]); if (d < since || d > until) return;
    const spend = +r[3] || 0, impr = +r[4] || 0, reach = r[5] === '' ? null : +r[5], link = +r[6] || 0, clicks = +r[7] || 0, res = +r[8] || 0;
    const o = { id: String(r[1]), date_start: d, amount_spent: spend, impressions: impr, reach: reach, link_click: link, clicks: clicks,
      cpm: impr ? spend / impr * 1000 : null, cpp: reach ? spend / reach * 1000 : null, cost_per_link_click: link ? spend / link : null, ctr: impr ? clicks / impr * 100 : null };
    o[MSG] = res; o[CPR] = res ? spend / res : null;
    (out[r[0]] || []).push(o);
  });
  return out;
}

/* ======================= called from the page ======================= */
function getAccount(acct, since, until, refresh) {
  if (AD_ACCOUNTS.indexOf(acct) < 0) throw new Error('unknown account');
  ensureDaily(acct, since, until, refresh);
  const ck = 'tot:' + acct + ':' + since + ':' + until;
  let tot = !refresh && cacheGet(ck);
  if (!tot) {
    tot = {};
    ['campaign', 'adset', 'ad'].forEach(lvl => {
      const rows = insights(acct, lvl, { since: since, until: until }, false);
      const attr = attributes(acct, lvl, rows.map(r => String(r.id)), refresh);
      tot[lvl] = rows.map(r => Object.assign({}, attr[r.id] || {}, r, { id: String(r.id) }));
    });
    tot.acc = accountInsights(acct, { since: since, until: until });
    cachePut(ck, tot, 600);
  }
  const daily = readDaily(acct, since, until), adPage = {};
  tot.ad.forEach(r => { if (r.page) adPage[r.id] = r.page; });
  const names = pageNames(Object.keys(adPage).map(k => adPage[k]).filter((v, i, a) => a.indexOf(v) === i));
  return { cT: tot.campaign, sT: tot.adset, aT: tot.ad, cD: daily.campaign, sD: daily.adset, aD: daily.ad, acc: tot.acc,
    adPage: adPage, pageNames: names, fetchedAt: new Date().toISOString() };
}
/* ad totals with their page, for the monthly Winning tab */
function getAdTotals(acct, since, until, refresh) {
  const ck = 'adt:' + acct + ':' + since + ':' + until, past = until < addDays(today(), -1);
  let out = !refresh && cacheGet(ck); if (out) return out;
  const rows = insights(acct, 'ad', { since: since, until: until }, false);
  const attr = attributes(acct, 'ad', rows.map(r => String(r.id)), false);
  const ads = rows.map(r => Object.assign({}, r, { id: String(r.id), page: (attr[r.id] || {}).page || null }));
  out = { ads: ads, pageNames: pageNames(ads.map(a => a.page).filter((v, i, a) => v && a.indexOf(v) === i)) };
  cachePut(ck, out, past ? 21600 : 600);
  return out;
}
/* all-time benchmark: Meta over the account's life; register / connect costs over the CRM window */
function getBench(acct, refresh) {
  const ck = 'bench:' + acct + ':' + today(); let out = !refresh && cacheGet(ck); if (out) return out;
  const win = { since: CRM_START, until: today() };
  out = { life: accountInsights(acct, { preset: 'maximum' }), win: accountInsights(acct, win), ids: insights(acct, 'ad', win, false).map(r => String(r.id)) };
  cachePut(ck, out, 21600);
  return out;
}

/* ---- CRM ledger ---- */
const SR_HEAD = ['SR No', 'p', 'd', 'u', 'a', 'au', 'ad', 'c', 'cu'];
const SUB_HEAD = ['asset_hash', 'd'];
function sheetObjects(id, mustHave) {
  const book = SpreadsheetApp.openById(id);
  for (const sh of book.getSheets()) {
    const v = sh.getDataRange().getValues(); if (!v.length) continue;
    const head = v[0].map(h => String(h).trim()); if (head.indexOf(mustHave) < 0) continue;
    return v.slice(1).map(r => { const o = {}; head.forEach((h, i) => o[h] = r[i]); return o; });
  }
  throw new Error('ไม่พบคอลัมน์ ' + mustHave + ' ในชีต ' + id);
}
function extractRecords(srRows, rcRows) {
  const sr = {}, subs = {}, hc = {}; const H = a => hc[a] || (hc[a] = h16(a));
  srRows.forEach(r => {
    const no = String(r['SR No'] || '').trim(); if (!no) return;
    const ad = (String(r['adsId'] || '').match(/\d{12,}/g) || []).join(',');
    const isFb = String(r['Channel'] || '').toLowerCase() === 'facebook';
    const pid = isFb ? CRM_PAGES[String(r['Sub Channel'] || '').trim()] : null;
    if (!isFb && !ad) return;
    const nums = String(r['Asset Number'] || '').match(/\d{6,}/g) || [];
    const a = nums.map(H).filter((v, i, x) => x.indexOf(v) === i);
    const u = r['Updated At'] ? bkkDate(r['Updated At']) : bkkDate(r['SR Open']), au = {}; a.forEach(h => au[h] = u);
    const c = String(r['Issue'] || '').trim() === 'ปิดการขายได้';
    sr[no] = { p: pid || '', d: bkkDate(r['SR Open']), u: u, a: a, au: au, ad: ad, c: c, cu: c ? u : '' };
  });
  rcRows.forEach(r => {
    if (String(r.SUBS_STATUS || '').toLowerCase() !== 'connect' || !r.APPOINT_DAY || !r.ASSET_NUM) return;
    const h = H(String(r.ASSET_NUM).trim()), d = ymd(r.APPOINT_DAY); if (!subs[h] || d < subs[h].d) subs[h] = { d: d };
  });
  return { sr: sr, subs: subs };
}
function mergeRec(o, n) {
  if (!o) return { rec: n, changed: true };
  const oa = o.a || [], na = (n.a || []).filter(h => oa.indexOf(h) < 0);
  const rec = Object.assign({}, o, { a: oa.concat(na), au: Object.assign({}, o.au || {}) }); let changed = na.length > 0;
  na.forEach(h => { rec.au[h] = (n.au && n.au[h]) || n.u || n.d; });
  oa.forEach(h => { if (!rec.au[h]) { rec.au[h] = (n.au && n.au[h]) || o.u || n.u || o.d; changed = true; } });
  if (!rec.u && n.u) { rec.u = n.u; changed = true; }
  if (n.c && !o.c) { rec.c = true; rec.cu = n.cu || n.u || n.d; changed = true; }
  if (o.c === undefined && n.c === false) { rec.c = false; changed = true; }
  if (n.ad && n.ad !== o.ad) { rec.ad = n.ad; changed = true; }
  if (!rec.p && n.p) { rec.p = n.p; changed = true; }
  return { rec: rec, changed: changed };
}
function readLedger(book) {
  const sr = {}, subs = {};
  readRows(tab(book, 'ledger_sr', SR_HEAD)).forEach(r => {
    if (!r[0]) return;
    sr[String(r[0])] = { p: String(r[1] || ''), d: ymd(r[2]), u: r[3] ? ymd(r[3]) : '', a: JSON.parse(r[4] || '[]'), au: JSON.parse(r[5] || '{}'),
      ad: String(r[6] || ''), c: r[7] === '' ? undefined : (r[7] === true || String(r[7]).toUpperCase() === 'TRUE'), cu: r[8] ? ymd(r[8]) : '' };
  });
  readRows(tab(book, 'ledger_subs', SUB_HEAD)).forEach(r => { if (r[0]) subs[String(r[0])] = { d: ymd(r[1]) }; });
  return { sr: sr, subs: subs };
}
/* read both sheets, add what is new to the ledger (nothing is ever removed), return the whole ledger */
function syncCrm() {
  const lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    const book = ledgerBook(), L = readLedger(book);
    let err = null, added = { nSr: 0, nReg: 0, nSub: 0 };
    try {
      const live = extractRecords(sheetObjects(CRM_SHEET_ID, 'SR No'), sheetObjects(REGIS_SHEET_ID, 'ASSET_NUM'));
      let changed = false;
      Object.keys(live.sr).forEach(no => {
        const o = L.sr[no], m = mergeRec(o, live.sr[no]);
        if (m.changed) { if (!o) added.nSr++; added.nReg += (m.rec.a.length - (o ? (o.a || []).length : 0)); L.sr[no] = m.rec; changed = true; }
      });
      Object.keys(live.subs).forEach(h => { const o = L.subs[h], n = live.subs[h]; if (!o) { L.subs[h] = n; added.nSub++; changed = true; } else if (n.d < o.d) { L.subs[h] = n; changed = true; } });
      if (changed) {
        writeRows(tab(book, 'ledger_sr', SR_HEAD), SR_HEAD, Object.keys(L.sr).sort().map(no => { const r = L.sr[no];
          return [no, r.p, r.d, r.u || '', JSON.stringify(r.a || []), JSON.stringify(r.au || {}), r.ad || '', r.c === undefined ? '' : !!r.c, r.cu || '']; }));
        writeRows(tab(book, 'ledger_subs', SUB_HEAD), SUB_HEAD, Object.keys(L.subs).sort().map(h => [h, L.subs[h].d]));
      }
    } catch (e) { err = String(e.message || e); }
    const meta = { lastSync: new Date().toISOString(), added: added };
    if (!err) P().setProperty('CRM_META', JSON.stringify(meta));
    return { sr: L.sr, subs: L.subs, meta: JSON.parse(prop('CRM_META') || 'null') || meta, added: added, err: err };
  } finally { lock.releaseLock(); }
}
function getCrm(refresh) {
  const meta = JSON.parse(prop('CRM_META') || 'null');
  /* sync when asked, or when the last sync is older than 10 minutes */
  if (refresh || !meta || Date.now() - Date.parse(meta.lastSync) > 600000) return syncCrm();
  const L = readLedger(ledgerBook());
  return { sr: L.sr, subs: L.subs, meta: meta, added: null, err: null };
}

/* ---- Winning calculator inputs, shared by everyone ---- */
function getWinInputs() { return JSON.parse(prop('WIN_INPUTS') || '{}'); }
function setWinInput(key, val) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { const all = getWinInputs(); all[key] = val; P().setProperty('WIN_INPUTS', JSON.stringify(all)); return all; }
  finally { lock.releaseLock(); }
}

/* ======================= optional: keep data warm every hour ======================= */
function hourlySync() {
  syncCrm();
  const t = today(), m1 = t.slice(0, 8) + '01';
  AD_ACCOUNTS.forEach(a => ensureDaily(a, m1 < CRM_START ? m1 : CRM_START, t, true));
}
function installHourlyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'hourlySync').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('hourlySync').timeBased().everyHours(1).create();
}
/* run once from the editor to check the setup */
function testSetup() {
  Logger.log('Meta: ' + JSON.stringify(accountInsights(AD_ACCOUNTS[0], { preset: 'last_7d' })));
  Logger.log('CRM rows: ' + sheetObjects(CRM_SHEET_ID, 'SR No').length);
  Logger.log('Regis rows: ' + sheetObjects(REGIS_SHEET_ID, 'ASSET_NUM').length);
  Logger.log('Ledger SR: ' + Object.keys(readLedger(ledgerBook()).sr).length);
}

/* ======================= one-time: copy the ledger kept by the Claude dashboard ======================= */
function seedLedger() {
  if (typeof SEED === 'undefined') throw new Error('ไม่พบไฟล์ Seed.gs');
  const lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    const book = ledgerBook(), L = readLedger(book);
    Object.keys(SEED.sr).forEach(no => { L.sr[no] = mergeRec(L.sr[no], SEED.sr[no]).rec; });
    Object.keys(SEED.subs).forEach(h => { const o = L.subs[h], n = SEED.subs[h]; if (!o || n.d < o.d) L.subs[h] = n; });
    writeRows(tab(book, 'ledger_sr', SR_HEAD), SR_HEAD, Object.keys(L.sr).sort().map(no => { const r = L.sr[no];
      return [no, r.p, r.d, r.u || '', JSON.stringify(r.a || []), JSON.stringify(r.au || {}), r.ad || '', r.c === undefined ? '' : !!r.c, r.cu || '']; }));
    writeRows(tab(book, 'ledger_subs', SUB_HEAD), SUB_HEAD, Object.keys(L.subs).sort().map(h => [h, L.subs[h].d]));
    Logger.log('ledger: ' + Object.keys(L.sr).length + ' SR, ' + Object.keys(L.subs).length + ' connected assets');
  } finally { lock.releaseLock(); }
}
