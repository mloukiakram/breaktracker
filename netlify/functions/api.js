// netlify/functions/api.js
// Break Tracker API
const { google } = require('googleapis');
const crypto     = require('crypto');

const SHEET_ID    = () => process.env.GOOGLE_SHEET_ID;
const LOG_RANGE   = 'Log!A:G';
const ACTIVE_RANGE = 'Active!A:B';
const LOG_HEADER  = ['Date','Member','Break Type','Start Time','End Time','Duration (mins)','Day of Week'];

const TZ = 'Africa/Casablanca';
const toDateStr = d => d.toLocaleDateString('en-GB', { timeZone: TZ });
const toTimeStr = d => d.toLocaleTimeString('en-GB', { hour12: false, timeZone: TZ });
const toDayStr = d => d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: TZ });
function parseDateStr(s) { const [dd,mm,yyyy] = s.split('/'); return new Date(yyyy, mm-1, dd); }

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
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: ACTIVE_RANGE });
    const rows = res.data.values || [];
    const active = {};
    for (const row of rows) {
      if (row[0] && row[1]) {
        try { active[row[0]] = JSON.parse(row[1]); } catch(e) {}
      }
    }
    return active;
  } catch (err) {
    console.error('Error reading active breaks', err);
    return {};
  }
}

async function writeActiveForMember(sheets, memberName, data) {
  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: ACTIVE_RANGE });
    rows = res.data.values || [];
  } catch(e) {}
  
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === memberName) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const value = data ? JSON.stringify(data) : '';
  
  try {
    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID(), range: ACTIVE_RANGE,
        valueInputOption: 'RAW',
        requestBody: { values: [[memberName, value]] }
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(), range: `Active!B${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] }
      });
    }
  } catch (err) {
    console.error('Error writing active break', err);
    throw new Error('Failed to update active sheet');
  }
}

async function ensureLogHeader(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: 'Log!A1:G1' });
    if (!res.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(), range: 'Log!A1:G1',
        valueInputOption: 'RAW', requestBody: { values: [LOG_HEADER] }
      });
    }
  } catch (err) {
    console.error('Error ensuring log header', err);
  }
}

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

  if (path === '/members' && method === 'GET') {
    return json(200, { members: Object.keys(memberPins), admin: adminName });
  }

  if (path === '/login' && method === 'POST') {
    const { member, pin } = body;
    if (!member || !pin) return json(400, { error: 'Member and PIN required to login' });
    const isAdmin  = member === adminName && pin === adminPin;
    const isMember = !isAdmin && memberPins[member] === pin;
    if (!isAdmin && !isMember) return json(401, { error: 'Incorrect PIN provided' });
    return json(200, { member, token: makeToken(member), isAdmin });
  }

  const authedMember = getAuth(event);
  if (!authedMember) return json(401, { error: 'Unauthorized access. Token invalid or expired.' });

  const isAdmin = authedMember === adminName;
  const sheets  = getSheets();
  const qs      = event.queryStringParameters || {};

  const validMembers = new Set([...Object.keys(memberPins), adminName]);

  function resolveTarget() {
    const target = body.targetMember;
    if (!target || target === authedMember) return { member: authedMember, byAdmin: false };
    if (!isAdmin) return { error: 'Only admin can act on behalf of others' };
    if (!validMembers.has(target)) return { error: 'Invalid target member specified' };
    return { member: target, byAdmin: true };
  }

  try {
    if (path === '/me' && method === 'GET') {
      const active = await readActive(sheets);
      return json(200, {
        member: authedMember, isAdmin,
        onBreak: !!active[authedMember],
        breakInfo: active[authedMember] || null
      });
    }

    if (path === '/me/history' && method === 'GET') {
      const period = qs.period || 'today';
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: LOG_RANGE });
      const rows = (res.data.values || []).slice(1).filter(r => r[0] && r[1] === authedMember);
      
      const now = new Date();
      const todayStr = toDateStr(now);
      
      const filtered = rows.filter(r => {
        if (period === 'today') return r[0] === todayStr;
        const d = parseDateStr(r[0]);
        if (period === 'week') {
          const w = new Date(now); w.setDate(w.getDate()-7);
          return d >= w;
        }
        if (period === 'month') {
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }
        return true;
      });
      
      const breaks = filtered.map(r => ({
        date: r[0], breakType: r[2], startTime: r[3], endTime: r[4], duration: parseInt(r[5]) || 0, day: r[6]
      })).reverse();
      
      return json(200, { breaks });
    }

    if (path === '/me/stats' && method === 'GET') {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: LOG_RANGE });
      const rows = (res.data.values || []).slice(1).filter(r => r[0] && r[1] === authedMember);
      
      const todayStr = toDateStr(new Date());
      const todays = rows.filter(r => r[0] === todayStr);
      
      const totalMins = todays.reduce((s, r) => s + (parseInt(r[5]) || 0), 0);
      const count = todays.length;
      const avgMins = count > 0 ? Math.round(totalMins / count) : 0;
      
      const typeBreakdown = {};
      todays.forEach(r => {
        typeBreakdown[r[2]] = (typeBreakdown[r[2]] || 0) + 1;
      });
      
      const last = todays[todays.length - 1];
      return json(200, {
        count, totalMins, avgMins, typeBreakdown,
        lastBreak: last ? { type: last[2], time: last[4] } : null
      });
    }

    if (path === '/break/start' && method === 'POST') {
      const { breakType } = body;
      if (!breakType) return json(400, { error: 'Break type is required to start a break' });
      const r = resolveTarget();
      if (r.error) return json(403, { error: r.error });
      const forMember = r.member;

      const active = await readActive(sheets);
      if (active[forMember]) return json(400, { error: `${forMember} already has an active break` });
      
      const now = new Date();
      const data = { breakType, startTime: toTimeStr(now), startTs: now.getTime() };
      await writeActiveForMember(sheets, forMember, data);
      
      return json(200, { startTime: toTimeStr(now), timestamp: now.getTime(), member: forMember, byAdmin: r.byAdmin });
    }

    if (path === '/break/end' && method === 'POST') {
      const r = resolveTarget();
      if (r.error) return json(403, { error: r.error });
      const forMember = r.member;

      const active = await readActive(sheets);
      const entry  = active[forMember];
      if (!entry) return json(400, { error: `No active break found for ${forMember}` });
      
      const now = new Date();
      const duration = Math.round((now.getTime() - entry.startTs) / 60000);
      
      await ensureLogHeader(sheets);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID(), range: LOG_RANGE, valueInputOption: 'RAW',
        requestBody: { values: [[
          toDateStr(now), forMember, entry.breakType, entry.startTime,
          toTimeStr(now), duration, toDayStr(now)
        ]]}
      });
      
      await writeActiveForMember(sheets, forMember, null);
      
      return json(200, { duration, endTime: toTimeStr(now), member: forMember, byAdmin: r.byAdmin });
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
      if (!isAdmin) return json(403, { error: 'Admin access required to view summary' });
      const period = qs.period || 'today';
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: LOG_RANGE });
      const rows = (res.data.values || []).slice(1).filter(r => r[0]);
      
      const now = new Date();
      const todayStr = toDateStr(now);
      
      const filtered = rows.filter(r => {
        if (period === 'today') return r[0] === todayStr;
        const d = parseDateStr(r[0]);
        if (period === 'week')  { const w = new Date(now); w.setDate(w.getDate()-7); return d >= w; }
        if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        return true;
      });
      
      const memberStats = {};
      const dailyMap = {};
      
      filtered.forEach(r => {
        const dateStr = r[0];
        const m = r[1];
        const mins = parseInt(r[5]) || 0;
        
        if (!memberStats[m]) memberStats[m] = { total: 0, count: 0, types: {}, longest: 0 };
        memberStats[m].total += mins;
        memberStats[m].count++;
        memberStats[m].types[r[2]] = (memberStats[m].types[r[2]] || 0) + 1;
        if (mins > memberStats[m].longest) memberStats[m].longest = mins;
        
        if (!dailyMap[dateStr]) dailyMap[dateStr] = { date: dateStr, count: 0, totalMins: 0 };
        dailyMap[dateStr].count++;
        dailyMap[dateStr].totalMins += mins;
      });
      
      const recent = filtered.slice(-30).reverse().map(r => ({
        date: r[0], member: r[1], breakType: r[2], startTime: r[3],
        endTime: r[4], duration: parseInt(r[5]) || 0, day: r[6]
      }));
      
      const dailyBreakdown = Object.values(dailyMap).sort((a,b) => parseDateStr(b.date) - parseDateStr(a.date));

      return json(200, { count: filtered.length, memberStats, recent, dailyBreakdown });
    }

    return json(404, { error: 'API route not found' });
  } catch (err) {
    console.error('[API Error]', err);
    return json(500, { error: 'Internal server error occurred while processing the request' });
  }
};
