// ═══ CONFIG ═══
const API = window.location.hostname === 'localhost' ? 'http://localhost:8888/api' : '/api';
const POLL_MS = 15000;
const WARN_MIN = 15;
const BREAK_TYPES = [
  { id: 'Coffee', label: 'Coffee', icon: 'local_cafe' },
  { id: 'Prayer', label: 'Prayer', icon: 'mosque' },
  { id: 'Lunch', label: 'Lunch', icon: 'restaurant' },
  { id: 'Phone Call', label: 'Phone Call', icon: 'call' },
  { id: 'Other', label: 'Other', icon: 'pause_circle' }
];

// ═══ STATE ═══
let session = JSON.parse(localStorage.getItem('bt_session') || 'null');
let members = [];
let adminName = '';
let loginMember = null;
let loginPin = '';
let selectedBreakType = null;
let timerInterval = null;
let pollInterval = null;
let activeBreaks = [];
let notifiedSet = new Set();
let currentHistoryPeriod = 'today';
let currentSummaryPeriod = 'today';
let modalTarget = null;
let modalType = null;

// ═══ UTILS ═══
const initials = name => name.slice(0, 2).toUpperCase();
const pad = n => n.toString().padStart(2, '0');
const formatDuration = mins => {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};
const show = id => document.getElementById(id)?.classList.add('active');
const hide = id => document.getElementById(id)?.classList.remove('active');

let toastTimeout;
function toast(msg) {
  const el = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 2500);
}

// ═══ API WRAPPER ═══
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['Authorization'] = `Bearer ${session.member}:${session.token}`;
  
  try {
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    const data = await res.json();
    if (res.status === 401 && session && path !== '/login') {
      logout('Session expired');
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
  } catch (err) {
    if (err.message === 'Session expired') throw err;
    if (err instanceof TypeError) {
      // Network error
      toast('Network error — check your connection');
    }
    throw err;
  }
}

// ═══ INIT ═══
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initLogin();
  
  if (session) {
    loadApp();
  } else {
    fetchMembers();
  }

  // Request notification permission if not granted
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
});

function initClock() {
  const update = () => {
    const now = new Date();
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const headerClock = document.getElementById('header-clock');
    const loginClock = document.getElementById('login-clock');
    if (headerClock) headerClock.textContent = timeStr;
    if (loginClock) loginClock.textContent = timeStr;
  };
  update();
  setInterval(update, 1000);
}

// ═══ LOGIN FLOW ═══
async function fetchMembers() {
  try {
    const data = await api('/members');
    members = data.members;
    adminName = data.admin;
    renderMembers();
  } catch (err) {
    toast('Failed to load members');
  }
}

function renderMembers() {
  const grid = document.getElementById('member-grid');
  // Include admin in the list if not already present
  const allMembers = [...new Set([...members, adminName])];
  grid.innerHTML = allMembers.map(m => `
    <div class="member-card" data-member="${m}" onclick="selectMember('${m}')">
      <div class="avatar">${initials(m)}</div>
      <div style="font-weight:500">${m}</div>
    </div>
  `).join('');
}

function selectMember(name) {
  loginMember = name;
  loginPin = '';
  // Highlight selected card
  document.querySelectorAll('.member-card').forEach(c => c.classList.remove('selected'));
  document.querySelector(`.member-card[data-member="${name}"]`)?.classList.add('selected');
  document.getElementById('member-grid').style.display = 'none';
  show('pin-panel');
  document.getElementById('pin-label').textContent = `Enter PIN for ${name}`;
  document.getElementById('pin-error').textContent = '';
  document.getElementById('pin-error').style.display = 'none';
  updatePinDisplay();
}

function initLogin() {
  document.getElementById('btn-back-login').onclick = () => {
    loginMember = null;
    hide('pin-panel');
    document.getElementById('member-grid').style.display = 'grid';
  };

  document.querySelectorAll('.key').forEach(btn => {
    btn.onclick = () => handlePinKey(btn.dataset.key);
  });
}

function updatePinDisplay() {
  const dots = document.querySelectorAll('.pin-dot');
  dots.forEach((dot, i) => {
    if (i < loginPin.length) dot.classList.add('filled');
    else dot.classList.remove('filled');
  });
}

async function handlePinKey(key) {
  if (key === 'C') loginPin = '';
  else if (key === 'B') loginPin = loginPin.slice(0, -1);
  else if (loginPin.length < 4) loginPin += key;

  updatePinDisplay();
  document.getElementById('pin-error').style.display = 'none';

  if (loginPin.length === 4) {
    try {
      const data = await api('/login', {
        method: 'POST',
        body: JSON.stringify({ member: loginMember, pin: loginPin })
      });
      session = data;
      localStorage.setItem('bt_session', JSON.stringify(session));
      loadApp();
    } catch (err) {
      document.getElementById('pin-error').textContent = 'Incorrect PIN — try again';
      document.getElementById('pin-error').style.display = 'block';
      loginPin = '';
      updatePinDisplay();
      // Shake animation
      const panel = document.getElementById('pin-panel');
      panel.style.animation = 'none';
      panel.offsetHeight; // force reflow
      panel.style.animation = '';
    }
  }
}

function logout(msg = 'Signed out') {
  session = null;
  localStorage.removeItem('bt_session');
  hide('s-app');
  show('s-login');
  loginMember = null;
  hide('pin-panel');
  document.getElementById('member-grid').style.display = 'grid';
  clearInterval(pollInterval);
  clearInterval(timerInterval);
  fetchMembers();
  toast(msg);
  document.title = 'Break Tracker';
}

// ═══ APP FLOW ═══
async function loadApp() {
  hide('s-login');
  show('s-app');
  
  // Always fetch members for the sidebar
  try {
    const data = await api('/members');
    members = data.members;
    adminName = data.admin;
    // Ensure admin is in the combined list
    if (!members.includes(adminName)) members.push(adminName);
  } catch (e) {
    console.error('Failed to fetch members', e);
  }
  
  document.getElementById('user-avatar').textContent = initials(session.member);
  document.getElementById('user-name').textContent = session.member;
  
  if (session.isAdmin) {
    document.getElementById('user-admin-chip').style.display = 'inline-flex';
    document.getElementById('nav-tabs').style.display = 'flex';
  } else {
    document.getElementById('user-admin-chip').style.display = 'none';
    document.getElementById('nav-tabs').style.display = 'none';
  }

  initTabs();
  renderBreakTypes();
  
  document.getElementById('btn-signout').onclick = () => logout();
  
  // Bind history pills
  document.querySelectorAll('#history-pills .period-pill').forEach(btn => {
    btn.onclick = (e) => {
      document.querySelectorAll('#history-pills .period-pill').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentHistoryPeriod = e.target.dataset.period;
      loadPersonalStats();
    };
  });

  document.querySelectorAll('#summary-pills .period-pill').forEach(btn => {
    btn.onclick = (e) => {
      document.querySelectorAll('#summary-pills .period-pill').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentSummaryPeriod = e.target.dataset.period;
      loadSummary();
    };
  });

  // Initial loads
  await checkMe();
  loadPersonalStats();
  pollTeamStatus();
  
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(pollTeamStatus, POLL_MS);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = (e) => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      
      e.target.classList.add('active');
      show(e.target.dataset.target);
      
      if (e.target.dataset.target === 'view-dashboard') {
        loadSummary();
      }
    };
  });
}

// ═══ BREAK LOGIC ═══
function renderBreakTypes() {
  const container = document.getElementById('break-types');
  container.innerHTML = BREAK_TYPES.map(t => `
    <div class="break-type-card" onclick="selectBreakType('${t.id}')" id="bt-${t.id}">
      <span class="break-type-icon material-symbols-rounded">${t.icon}</span>
      <span class="break-type-label">${t.label}</span>
    </div>
  `).join('');
  
  document.getElementById('btn-start-break').onclick = () => startBreak();
  document.getElementById('btn-end-break').onclick = () => endBreak();
}

function selectBreakType(id) {
  selectedBreakType = id;
  document.querySelectorAll('.break-type-card').forEach(c => c.classList.remove('selected'));
  document.getElementById(`bt-${id}`).classList.add('selected');
  document.getElementById('btn-start-break').disabled = false;
}

async function checkMe() {
  try {
    const data = await api('/me');
    if (data.onBreak) {
      setUiActiveBreak(data.breakInfo);
    } else {
      setUiStartBreak();
    }
  } catch (err) {
    console.error(err);
  }
}

function setUiStartBreak() {
  hide('ui-active-break');
  document.getElementById('ui-start-break').classList.add('active');
  selectedBreakType = null;
  document.querySelectorAll('.break-type-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('btn-start-break').disabled = true;
  clearInterval(timerInterval);
}

function setUiActiveBreak(info) {
  document.getElementById('ui-start-break').classList.remove('active');
  show('ui-active-break');
  
  const b = BREAK_TYPES.find(t => t.id === info.breakType) || BREAK_TYPES[4];
  document.getElementById('active-break-type').innerHTML = `<span class="material-symbols-rounded" style="font-size:inherit; vertical-align:middle; margin-right:4px;">${b.icon}</span>${b.label}`;
  
  const d = new Date(info.startTs || Date.now());
  document.getElementById('active-break-start').textContent = `Started at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  
  startTimer(info.startTs);
}

function startTimer(startTs) {
  clearInterval(timerInterval);
  const panel = document.getElementById('ui-active-break');
  
  const tick = () => {
    const diff = Math.floor((Date.now() - startTs) / 1000);
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    document.getElementById('active-timer').textContent = `${pad(m)}:${pad(s)}`;
    
    if (m >= WARN_MIN) {
      panel.classList.add('overdue');
    } else {
      panel.classList.remove('overdue');
    }
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

async function startBreak(targetMember = null) {
  const type = targetMember ? document.getElementById('admin-break-select')?.value : selectedBreakType;
  if (!type) return;
  
  const btn = targetMember ? document.getElementById('modal-confirm') : document.getElementById('btn-start-break');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Starting...';
  
  try {
    const data = await api('/break/start', {
      method: 'POST',
      body: JSON.stringify({ breakType: type, targetMember })
    });
    
    if (targetMember) {
      toast(`Started break for ${targetMember}`);
      closeModal();
      pollTeamStatus();
    } else {
      setUiActiveBreak({ breakType: type, startTs: data.timestamp });
      toast('Break started');
      pollTeamStatus();
    }
  } catch (err) {
    toast(err.message || 'Failed to start break');
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function endBreak(targetMember = null) {
  const btn = targetMember ? document.getElementById('modal-confirm') : document.getElementById('btn-end-break');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Ending...';
  
  try {
    const data = await api('/break/end', {
      method: 'POST',
      body: JSON.stringify({ targetMember })
    });
    
    if (targetMember) {
      toast(`Ended break for ${targetMember} (${data.duration}m)`);
      closeModal();
      pollTeamStatus();
    } else {
      setUiStartBreak();
      toast(`Break ended — ${formatDuration(data.duration)}`);
      loadPersonalStats();
      pollTeamStatus();
    }
  } catch (err) {
    toast(err.message || 'Failed to end break');
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ═══ DATA LOADING ═══
async function loadPersonalStats() {
  document.getElementById('history-list').innerHTML = `
    <div class="skeleton" style="height: 64px; width:100%;"></div>
    <div class="skeleton" style="height: 64px; width:100%;"></div>
  `;
  try {
    const [stats, history] = await Promise.all([
      api(`/me/stats?period=${currentHistoryPeriod}`),
      api(`/me/history?period=${currentHistoryPeriod}`)
    ]);
    
    document.getElementById('stat-count').textContent = stats.count;
    document.getElementById('stat-total').textContent = formatDuration(stats.totalMins);
    document.getElementById('stat-avg').textContent = formatDuration(Math.round(stats.avgMins || 0));
    
    renderHistory(history.breaks);
  } catch (err) {
    console.error(err);
  }
}

function renderHistory(breaks) {
  const list = document.getElementById('history-list');
  if (!breaks || breaks.length === 0) {
    list.innerHTML = `<div class="empty-state">No breaks recorded for this period</div>`;
    return;
  }
  
  list.innerHTML = breaks.map(b => {
    const bt = BREAK_TYPES.find(t => t.id === b.breakType) || BREAK_TYPES[4];
    return `
      <div class="history-item" data-type="${b.breakType}">
        <div class="history-item-left">
          <div class="history-item-title" style="display:flex; align-items:center; gap:6px;"><span class="material-symbols-rounded" style="font-size:18px;">${bt.icon}</span> ${b.breakType} <span class="history-item-time">• ${b.date}</span></div>
          <div class="history-item-time">${b.startTime} &rarr; ${b.endTime || 'Ongoing'}</div>
        </div>
        <div class="pill ${b.duration > 15 ? 'amber' : 'green'}">${formatDuration(b.duration || 0)}</div>
      </div>
    `;
  }).join('');
}

async function pollTeamStatus() {
  if (!session) return;
  try {
    const data = await api('/breaks/active');
    activeBreaks = data.active;
    renderTeamSidebar();
    checkNotifications();
  } catch (err) {
    console.error(err);
  }
}

function renderTeamSidebar() {
  const onBreak = activeBreaks;
  const atPost = members.filter(m => !onBreak.find(b => b.member === m));
  
  document.getElementById('title-on-break').textContent = `On Break (${onBreak.length})`;
  document.getElementById('title-at-post').textContent = `At Post (${atPost.length})`;
  
  const listOnBreak = document.getElementById('list-on-break');
  if (onBreak.length === 0) {
    listOnBreak.innerHTML = `<div class="empty-state" style="padding:20px; font-size:0.9rem;">No one on break</div>`;
  } else {
    listOnBreak.innerHTML = onBreak.map(b => {
      const isOverdue = b.elapsedMins >= WARN_MIN;
      return `
        <div class="member-row">
          <div class="member-info">
            <div class="avatar" style="width:28px; height:28px; font-size:0.75rem">${initials(b.member)}</div>
            <div>
              <div class="member-name">${b.member}</div>
              <div style="font-size:0.75rem; color:var(--text-secondary)">${b.breakType}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="pill ${isOverdue ? 'red' : 'amber'}">${b.elapsedMins}m</div>
            ${session.isAdmin && b.member !== session.member ? 
              `<button class="btn-danger" style="padding:4px 8px; font-size:0.75rem" onclick="openEndModal('${b.member}')">End</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }
  
  const listAtPost = document.getElementById('list-at-post');
  listAtPost.innerHTML = atPost.map(m => `
    <div class="member-row">
      <div class="member-info">
        <div class="avatar" style="width:28px; height:28px; font-size:0.75rem">${initials(m)}</div>
        <div class="member-name">${m}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <div class="dot green"></div>
        ${session.isAdmin && m !== session.member ? 
          `<button class="btn-secondary" style="padding:4px 8px; font-size:0.75rem" onclick="openStartModal('${m}')">Start</button>` : ''}
      </div>
    </div>
  `).join('');
}

function checkNotifications() {
  let overdueCount = 0;
  activeBreaks.forEach(b => {
    if (b.elapsedMins >= WARN_MIN) {
      overdueCount++;
      const id = `${b.member}-${b.startTs}`;
      if (!notifiedSet.has(id) && "Notification" in window && Notification.permission === "granted") {
        new Notification("Break Tracker", {
          body: `${b.member} has been on ${b.breakType} break for ${b.elapsedMins}m.`,
          icon: '/favicon.ico'
        });
        notifiedSet.add(id);
      }
    }
  });
  
  if (overdueCount > 0) {
    document.title = `(${overdueCount}) Break Tracker`;
  } else {
    document.title = 'Break Tracker';
  }
}

// ═══ ADMIN DASHBOARD ═══
async function loadSummary() {
  const bars = document.getElementById('summary-bars');
  const recent = document.getElementById('summary-recent');
  
  bars.innerHTML = '<div class="skeleton" style="height: 100px; margin-bottom:16px;"></div>'.repeat(3);
  recent.innerHTML = '<div class="skeleton" style="height: 64px; margin-bottom:16px;"></div>'.repeat(3);
  
  try {
    const data = await api(`/summary?period=${currentSummaryPeriod}`);
    
    document.getElementById('sum-count').textContent = data.count;
    document.getElementById('sum-total').textContent = formatDuration(Object.values(data.memberStats).reduce((acc, s) => acc + s.total, 0));
    document.getElementById('sum-avg').textContent = data.count > 0 ? formatDuration(Math.round(Object.values(data.memberStats).reduce((acc, s) => acc + s.total, 0) / data.count)) : '0m';
    
    let maxMins = 1;
    Object.values(data.memberStats).forEach(s => { if (s.total > maxMins) maxMins = s.total; });
    
    bars.innerHTML = Object.entries(data.memberStats).map(([name, stat]) => {
      const pct = Math.min(100, Math.max(0, (stat.total / maxMins) * 100));
      return `
        <div class="breakdown-row">
          <div class="breakdown-header">
            <div style="font-weight:500">${name}</div>
            <div style="color:var(--text-secondary)">${stat.count} breaks, ${formatDuration(stat.total)}</div>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
    
    if (data.recent.length === 0) {
      recent.innerHTML = '<div class="empty-state">No recent activity</div>';
    } else {
      recent.innerHTML = data.recent.map(b => `
        <div class="history-item">
          <div class="history-item-left">
            <div class="history-item-title">${b.member} <span style="font-weight:normal; color:var(--text-secondary)">- ${b.breakType}</span></div>
            <div class="history-item-time">${b.date} • ${b.startTime} &rarr; ${b.endTime || 'Ongoing'}</div>
          </div>
          <div class="pill ${b.duration > 15 ? 'amber' : 'green'}">${formatDuration(b.duration || 0)}</div>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error(err);
  }
}

// ═══ MODALS ═══
function openStartModal(member) {
  modalTarget = member;
  modalType = 'start';
  
  const opts = BREAK_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
  
  document.getElementById('modal-title').textContent = `Start Break for ${member}`;
  document.getElementById('modal-desc').textContent = `Force start a break for this member.`;
  document.getElementById('modal-body').innerHTML = `
    <select id="admin-break-select" class="modal-select">
      ${opts}
    </select>
  `;
  document.getElementById('modal-confirm').textContent = 'Start Break';
  document.getElementById('modal-confirm').className = 'btn-primary';
  
  show('modal-overlay');
}

function openEndModal(member) {
  modalTarget = member;
  modalType = 'end';
  
  document.getElementById('modal-title').textContent = `End Break for ${member}`;
  document.getElementById('modal-desc').textContent = `Are you sure you want to end ${member}'s active break?`;
  document.getElementById('modal-body').innerHTML = '';
  document.getElementById('modal-confirm').textContent = 'End Break';
  document.getElementById('modal-confirm').className = 'btn-danger';
  
  show('modal-overlay');
}

function closeModal() {
  hide('modal-overlay');
  modalTarget = null;
  modalType = null;
}

document.getElementById('modal-cancel').onclick = closeModal;
document.getElementById('modal-overlay').onclick = (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
};

document.getElementById('modal-confirm').onclick = () => {
  if (modalType === 'start') {
    startBreak(modalTarget);
  } else if (modalType === 'end') {
    endBreak(modalTarget);
  }
};
