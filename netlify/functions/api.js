// netlify/functions/api.js
// Break Tracker API
const { google } = require('googleapis');
const crypto     = require('crypto');

const SHEET_ID    = () => process.env.GOOGLE_SHEET_ID;
const LOG_RANGE   = 'Log!A:G';
const ACTIVE_CELL = 'Active!A1';
const LOG_HEADER  = ['Date','Member','Break Type','Start Time','End Time','Duration (mins)','Day of Week'];

function getSheets() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

function makeToken(member) {
  const day = new Date().toISOString().split('T')[0];
  return crypto.createHmac('sha256', process.env.TOKEN_SECRET || 'change-me')
    .update(`${member}:${day}`).digest('hex');
}

function verifyToken(member, token) {
  if (!member || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(makeToken(member));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getAuth(event) {
  const header = event.headers['authorization'] || '';
  const match  = header.match(/^Bearer (.+):(.+)$/);
  if (!match) return null;
  const [, member, token] = match;
  if (!verifyToken(member, token)) return null;
  return member;
}

async function readActive(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: ACTIVE_CELL });
    const raw = (res.data.values?.[0]?.[0] || '').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function writeActive(sheets, data) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(), range: ACTIVE_CELL,
    valueInputOption: 'RAW',
    requestBody: { values: [[JSON.stringify(data)]] }
  });
}

async function ensureLogHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: 'Log!A1:G1' });
  if (!res.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(), range: 'Log!A1:G1',
      valueInputOption: 'RAW', requestBody: { values: [LOG_HEADER] }
    });
  }
}

const toDateStr = d => d.toLocaleDateString('en-GB');
const toTimeStr = d => d.toLocaleTimeString('en-GB', { hour12: false });
function parseDateStr(s) { const [dd,mm,yyyy] = s.split('/'); return new Date(yyyy, mm-1, dd); }

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const path = event.path.replace(/\/?\.netlify\/functions\/api/, '').replace(/\/api/, '').replace(/\/$/, '') || '/';
  const method = event.httpMethod;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  const memberPins = JSON.parse(process.env.MEMBER_PINS || '{}');
  const adminName  = process.env.ADMIN_NAME || 'Akram';
  const adminPin   = process.env.ADMIN_PIN  || '9999';

  if (path === '/login' && method === 'POST') {
    const { member, pin } = body;
    if (!member || !pin) return json(400, { error: 'Member and PIN required' });
    const isAdmin  = member === adminName && pin === adminPin;
    const isMember = !isAdmin && memberPins[member] === pin;
    if (!isAdmin && !isMember) return json(401, { error: 'Incorrect PIN' });
    return json(200, { member, token: makeToken(member), isAdmin });
  }

  const authedMember = getAuth(event);
  if (!authedMember) return json(401, { error: 'Unauthorized' });

  const isAdmin = authedMember === adminName;
  const sheets  = getSheets();
  const qs      = event.queryStringParameters || {};

  try {
    if (path === '/me' && method === 'GET') {
      const active = await readActive(sheets);
      return json(200, {
        member: authedMember, isAdmin,
        onBreak: !!active[authedMember],
        breakInfo: active[authedMember] || null
      });
    }

    // ── Personal stats for today ──
    if (path === '/me/stats' && method === 'GET') {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: LOG_RANGE });
      const rows = (res.data.values || []).slice(1).filter(r => r[0] && r[1] === authedMember);
      const today = new Date().toDateString();
      const todays = rows.filter(r => parseDateStr(r[0]).toDateString() === today);
      const total = todays.reduce((s, r) => s + (parseInt(r[5]) || 0), 0);
      const last  = todays[todays.length - 1];
      return json(200, {
        count: todays.length,
        totalMins: total,
        lastBreak: last ? { type: last[2], time: last[4] } : null
      });
    }

    if (path === '/break/start' && method === 'POST') {
      const { breakType } = body;
      if (!breakType) return json(400, { error: 'Break type required' });
      const active = await readActive(sheets);
      if (active[authedMember]) return json(400, { error: 'You already have an active break' });
      const now = new Date();
      active[authedMember] = { breakType, startTime: toTimeStr(now), startTs: now.getTime() };
      await writeActive(sheets, active);
      return json(200, { startTime: toTimeStr(now), timestamp: now.getTime() });
    }

    if (path === '/break/end' && method === 'POST') {
      const active = await readActive(sheets);
      const entry  = active[authedMember];
      if (!entry) return json(400, { error: 'No active break found' });
      const now = new Date();
      const duration = Math.round((now.getTime() - entry.startTs) / 60000);
      await ensureLogHeader(sheets);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID(), range: LOG_RANGE, valueInputOption: 'RAW',
        requestBody: { values: [[
          toDateStr(now), authedMember, entry.breakType, entry.startTime,
          toTimeStr(now), duration, now.toLocaleDateString('en-GB', { weekday: 'long' })
        ]]}
      });
      delete active[authedMember];
      await writeActive(sheets, active);
      return json(200, { duration, endTime: toTimeStr(now) });
    }

    if (path === '/breaks/active' && method === 'GET') {
      const active = await readActive(sheets);
      const now = Date.now();
      const list = Object.entries(active).map(([member, info]) => ({
        member, breakType: info.breakType, startTime: info.startTime,
        startTs: info.startTs, elapsedMins: Math.floor((now - info.startTs) / 60000)
      }));
      return json(200, { active: list });
    }

    if (path === '/summary' && method === 'GET') {
      if (!isAdmin) return json(403, { error: 'Admin access required' });
      const period = qs.period || 'today';
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: LOG_RANGE });
      const rows = (res.data.values || []).slice(1).filter(r => r[0]);
      const now = new Date();
      const filtered = rows.filter(r => {
        const d = parseDateStr(r[0]);
        if (period === 'today') return d.toDateString() === now.toDateString();
        if (period === 'week')  { const w = new Date(now); w.setDate(w.getDate()-7); return d >= w; }
        if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        return true;
      });
      const memberStats = {};
      filtered.forEach(r => {
        const m = r[1];
        if (!memberStats[m]) memberStats[m] = { total: 0, count: 0, types: {}, longest: 0 };
        const mins = parseInt(r[5]) || 0;
        memberStats[m].total += mins;
        memberStats[m].count++;
        memberStats[m].types[r[2]] = (memberStats[m].types[r[2]] || 0) + 1;
        if (mins > memberStats[m].longest) memberStats[m].longest = mins;
      });
      const recent = filtered.slice(-30).reverse().map(r => ({
        date: r[0], member: r[1], breakType: r[2], startTime: r[3],
        endTime: r[4], duration: parseInt(r[5]) || 0, day: r[6]
      }));
      return json(200, { count: filtered.length, memberStats, recent });
    }

    return json(404, { error: 'Route not found' });
  } catch (err) {
    console.error('[API Error]', err);
    return json(500, { error: 'Internal server error' });
  }
};
