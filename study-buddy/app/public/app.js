/* global Terminal, FitAddon */

// ── State ──
let currentPlan = null;
let segments = [];
let activeSegmentIndex = -1;
let sessionStartTime = null;
let totalInterval = null;
let timerPaused = false;
let ws = null;
let term = null;
let fitAddon = null;
let terminalMinimized = false;
let notesVisible = false;
let notesSaveTimeout = null;
let reflectionSaveTimeout = null;
let reflectionRating = 0;

// transcript / stage tracking
let termTranscript = '';
let currentStage = 'Phase 1: Study Plan';
let sessionContextPath = null;
let lastStoredStage = '';
let analysisPollInterval = null;
let stageDetectTimeout = null;

// ── Segment names mapping ──
const SEGMENT_LABELS = {
  'introduction': 'Reading',
  'terms': 'Terms',
  'commands': 'Commands',
  'questions': 'Questions',
  'hands-on': 'Hands-on'
};

// Default expected time proportions (fraction of total) as fallback
const DEFAULT_PROPORTIONS = {
  'introduction': 0.20,
  'terms': 0.10,
  'commands': 0.05,
  'questions': 0.25,
  'hands-on': 0.40
};

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  loadPlanList();
  document.getElementById('back-btn').addEventListener('click', goBack);
  document.getElementById('save-btn').addEventListener('click', saveSession);
  setupDivider();
  setupVisibilityTracking();
  setupSearch();
  setupNotes();
  setupReflection();
  setupTerminalMinimize();
  setupPhaseIndicator();
});

// ── Visibility API — pause timer when tab/window not visible ──
function setupVisibilityTracking() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      timerPaused = true;
      document.getElementById('pause-badge')?.classList.remove('hidden');
    } else {
      timerPaused = false;
      document.getElementById('pause-badge')?.classList.add('hidden');
    }
  });

  window.addEventListener('blur', () => {
    timerPaused = true;
    document.getElementById('pause-badge')?.classList.remove('hidden');
  });
  window.addEventListener('focus', () => {
    timerPaused = false;
    document.getElementById('pause-badge')?.classList.add('hidden');
  });
}

// ── Search ──
function setupSearch() {
  const input = document.getElementById('plan-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('#plan-list .plan-card').forEach(card => {
      const title = card.querySelector('.plan-card-title')?.textContent.toLowerCase() || '';
      card.classList.toggle('hidden', q.length > 0 && !title.includes(q));
    });
  });
}

// ── Plan List ──
async function loadPlanList() {
  const [plansRes, analyticsRes] = await Promise.all([
    fetch('/api/plans'),
    fetch('/api/analytics')
  ]);
  const plans = await plansRes.json();
  const allAnalytics = await analyticsRes.json().catch(() => []);

  // Find best session per slug (most segments completed)
  const bestBySlug = {};
  (Array.isArray(allAnalytics) ? allAnalytics : []).forEach(a => {
    const key = a.subject;
    const current = bestBySlug[key];
    const completedCount = (a.completedSegments || []).length;
    const currentCount = current ? (current.completedSegments || []).length : -1;
    if (completedCount > currentCount) bestBySlug[key] = a;
  });

  const list = document.getElementById('plan-list');

  if (plans.length === 0) {
    list.innerHTML = '<p style="color: var(--text-dim)">No study plans found in ~/study-plans/</p>';
    return;
  }

  list.innerHTML = plans.map(p => {
    const analytics = bestBySlug[p.slug];
    const { pct, label, colorClass } = computeCompletion(analytics);
    const ringHtml = buildCompletionRing(pct, colorClass);

    return `
    <div class="plan-card" data-slug="${p.slug}">
      <div class="plan-card-main">
        <div class="plan-card-title">${p.title}</div>
        <div class="plan-card-meta">${p.date}${p.duration ? ' · ' + p.duration : ''}</div>
        <div class="plan-card-progress-bar">
          <div class="plan-card-progress-fill ${colorClass}" style="width: ${pct}%"></div>
        </div>
      </div>
      <div class="plan-card-completion">
        ${ringHtml}
        <span class="completion-label ${colorClass}">${label}</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.plan-card').forEach(card => {
    card.addEventListener('click', () => loadPlan(card.dataset.slug));
  });

  // Re-apply search filter if already typed
  const q = document.getElementById('plan-search')?.value.trim().toLowerCase() || '';
  if (q) {
    list.querySelectorAll('.plan-card').forEach(card => {
      const title = card.querySelector('.plan-card-title')?.textContent.toLowerCase() || '';
      card.classList.toggle('hidden', !title.includes(q));
    });
  }
}

function computeCompletion(analytics) {
  if (!analytics) return { pct: 0, label: 'Not started', colorClass: 'completion-none' };
  const total = Object.keys(analytics.segments || {}).length;
  const completed = (analytics.completedSegments || []).length;
  if (total === 0) return { pct: 0, label: 'Not started', colorClass: 'completion-none' };
  const pct = Math.round(completed / total * 100);
  if (pct === 100) return { pct, label: '100%', colorClass: 'completion-done' };
  if (pct >= 60)   return { pct, label: `${pct}%`, colorClass: 'completion-mid' };
  return { pct, label: `${pct}%`, colorClass: 'completion-low' };
}

function buildCompletionRing(pct, colorClass) {
  const r = 13;
  const cx = 16;
  const cy = 16;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  return `
    <svg class="completion-ring ${colorClass}" width="32" height="32" viewBox="0 0 32 32">
      <circle class="ring-bg" cx="${cx}" cy="${cy}" r="${r}" />
      <circle class="ring-fill" cx="${cx}" cy="${cy}" r="${r}"
        stroke-dasharray="${circ.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}" />
    </svg>`;
}

// ── Load Plan ──
async function loadPlan(slug) {
  const res = await fetch(`/api/plan/${slug}`);
  const data = await res.json();
  currentPlan = { slug, content: data.content };

  const totalPlannedSeconds = parsePlannedDuration(data.content);
  segments = parseSections(data.content, totalPlannedSeconds);

  const saved = localStorage.getItem(`sb-timers-${slug}`);
  if (saved) {
    const savedTimers = JSON.parse(saved);
    segments.forEach(s => {
      if (savedTimers[s.id] !== undefined) s.elapsed = savedTimers[s.id];
    });
  }

  document.getElementById('plan-selector').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const titleMatch = data.content.match(/^#\s+Study Plan:\s+(.+)/m);
  document.getElementById('plan-title').textContent = titleMatch ? titleMatch[1] : slug;

  const totalExpected = segments.reduce((sum, s) => sum + s.expectedSeconds, 0);
  const totalExpEl = document.getElementById('total-expected');
  if (totalExpEl && totalExpected > 0) {
    totalExpEl.textContent = `/ ${formatTime(totalExpected)}`;
  }

  renderSegmentBar();
  renderSections();
  startTotalTimer();
  setupStartButton();
  setActiveSegment(0);

  // Load notes and reflection
  loadNotes(slug);
  loadReflection(slug);

  // Fetch session context (writes /tmp context file, gets current stage)
  termTranscript = '';
  lastStoredStage = '';
  sessionContextPath = null;
  try {
    const ctxRes = await fetch(`/api/session-context/${slug}`);
    if (ctxRes.ok) {
      const ctxData = await ctxRes.json();
      sessionContextPath = ctxData.contextPath;
      currentStage = ctxData.stage || 'Phase 1: Study Plan';
      lastStoredStage = currentStage;
      updatePhaseIndicator(currentStage);
    }
  } catch (e) { /* non-fatal */ }

  // Reset terminal minimize state
  if (terminalMinimized) {
    terminalMinimized = false;
    applyTerminalMinimizeState();
  }
}

// ── Parse planned duration from header ──
function parsePlannedDuration(md) {
  const match = md.match(/\*\*Chosen duration:\*\*\s*(.+)/m);
  if (!match) return 0;
  const text = match[1].toLowerCase();
  let minutes = 0;
  const hrMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour)/);
  const minMatch = text.match(/(\d+)\s*min/);
  if (hrMatch) minutes += parseFloat(hrMatch[1]) * 60;
  if (minMatch) minutes += parseInt(minMatch[1]);
  if (!hrMatch && !minMatch) {
    const num = parseFloat(text);
    if (!isNaN(num)) minutes = num * 60;
  }
  return minutes * 60;
}

// ── Parse expected time from section heading comment ──
function parseExpectedTime(line) {
  const match = line.match(/<!--\s*expected:\s*(?:(\d+)h)?\s*(\d+)m\s*-->/);
  if (!match) return 0;
  const hours = match[1] ? parseInt(match[1]) : 0;
  const mins  = match[2] ? parseInt(match[2]) : 0;
  return (hours * 60 + mins) * 60;
}

// ── Parse Markdown into Sections ──
function parseSections(md, totalPlannedSeconds) {
  const lines = md.split('\n');
  const sections = [];
  let current = null;
  let inHeader = true;

  for (const line of lines) {
    const sectionMatch = line.match(/^## Section \d+:\s+(.+?)(?:\s*<!--.*-->)?\s*$/);
    if (sectionMatch) {
      if (current) sections.push(current);
      inHeader = false;
      const title = sectionMatch[1].trim();
      const id = inferSegmentId(title);
      const expectedSeconds = parseExpectedTime(line);
      current = { id, title, lines: [], elapsed: 0, expectedSeconds, started: null, ended: null };
    } else if (current) {
      if (line.match(/^## /) && !line.match(/^## Section \d+:/)) {
        sections.push(current);
        current = null;
      } else {
        current.lines.push(line);
      }
    } else if (inHeader) {
      // skip header lines
    }
  }
  if (current) sections.push(current);

  const hasExpected = sections.some(s => s.expectedSeconds > 0);
  if (!hasExpected && totalPlannedSeconds > 0) {
    sections.forEach(s => {
      const proportion = DEFAULT_PROPORTIONS[s.id] || (1 / sections.length);
      s.expectedSeconds = Math.round(totalPlannedSeconds * proportion);
    });
  }

  sections.forEach(s => { s.html = simpleMarkdown(s.lines.join('\n')); });
  return sections;
}

function inferSegmentId(title) {
  const t = title.toLowerCase();
  if (t.includes('introduction') || t.includes('reading')) return 'introduction';
  if (t.includes('term') || t.includes('keyword')) return 'terms';
  if (t.includes('command')) return 'commands';
  if (t.includes('question') || t.includes('understanding')) return 'questions';
  if (t.includes('hands-on') || t.includes('task')) return 'hands-on';
  return t.replace(/[^a-z0-9]+/g, '-');
}

// ── Simple Markdown Renderer ──
function simpleMarkdown(text) {
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code>${escapeHtml(code.trim())}</code></pre>`)
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  const lines = html.split('\n');
  const result = [];
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { result.push(''); continue; }
    if (trimmed.startsWith('<h') || trimmed.startsWith('<pre') || trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol') || trimmed.startsWith('<li') || trimmed.startsWith('<hr') ||
        trimmed.startsWith('<blockquote') || trimmed.startsWith('</')) {
      result.push(line); continue;
    }
    if (trimmed.startsWith('<pre')) { inBlock = true; }
    if (trimmed.includes('</pre>')) { inBlock = false; }
    if (inBlock) { result.push(line); continue; }
    result.push(`<p>${trimmed}</p>`);
  }

  return result.join('\n');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Progress helpers ──
function getProgress(segment) {
  if (!segment.expectedSeconds || segment.expectedSeconds <= 0) return null;
  return Math.min(segment.elapsed / segment.expectedSeconds, 1.5);
}

function getProgressColor(ratio) {
  if (ratio === null) return 'var(--accent)';
  if (ratio <= 0.75) return 'var(--accent)';
  if (ratio <= 1.0)  return 'var(--yellow)';
  return 'var(--red)';
}

function getProgressClass(ratio) {
  if (ratio === null) return '';
  if (ratio <= 0.75) return '';
  if (ratio <= 1.0)  return 'warning';
  return 'overtime';
}

// ── Render Segment Bar ──
function renderSegmentBar() {
  const bar = document.getElementById('segment-bar');
  bar.innerHTML = segments.map((s, i) => {
    const progress = getProgress(s);
    const pClass = getProgressClass(progress);
    const pct = progress !== null ? Math.min(progress * 100, 100) : 0;
    const expectedLabel = s.expectedSeconds > 0 ? formatTime(s.expectedSeconds) : '';

    return `
    <div class="segment-pill${i === activeSegmentIndex ? ' active' : ''} ${pClass}" data-index="${i}">
      <div class="pill-progress-bg" id="pill-progress-${i}" style="width: ${pct}%"></div>
      <span class="pill-label">${SEGMENT_LABELS[s.id] || s.title}</span>
      <span class="pill-time" id="pill-time-${i}">${formatTime(s.elapsed)}${expectedLabel ? ' / ' + expectedLabel : ''}</span>
    </div>`;
  }).join('');

  bar.querySelectorAll('.segment-pill').forEach(pill => {
    pill.addEventListener('click', () => setActiveSegment(parseInt(pill.dataset.index)));
  });
}

// ── Render Sections ──
function renderSections() {
  const container = document.getElementById('plan-sections');
  container.innerHTML = segments.map((s, i) => {
    const progress = getProgress(s);
    const pClass = getProgressClass(progress);
    const pct = progress !== null ? Math.min(progress * 100, 100) : 0;
    const expectedLabel = s.expectedSeconds > 0 ? ` / ${formatTime(s.expectedSeconds)}` : '';

    return `
    <div class="section-card${i === activeSegmentIndex ? ' active expanded' : ''} ${pClass}" data-index="${i}" id="section-${i}">
      <div class="section-header">
        <span class="section-title">${s.title}</span>
        <span class="section-timer">
          <span class="timer-dot"></span>
          <span id="section-time-${i}">${formatTime(s.elapsed)}</span>
          <span class="section-expected" id="section-expected-${i}">${expectedLabel}</span>
        </span>
      </div>
      <div class="section-progress-bar">
        <div class="section-progress-fill" id="section-progress-${i}" style="width: ${pct}%"></div>
      </div>
      <div class="section-body">${s.html}</div>
    </div>`;
  }).join('');

  container.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.section-card');
      setActiveSegment(parseInt(card.dataset.index));
    });
  });
}

// ── Set Active Segment ──
function setActiveSegment(index) {
  if (index === activeSegmentIndex) {
    document.getElementById(`section-${index}`)?.classList.toggle('expanded');
    return;
  }

  if (activeSegmentIndex >= 0 && segments[activeSegmentIndex]) {
    if (!segments[activeSegmentIndex].ended) {
      segments[activeSegmentIndex].ended = new Date().toISOString();
    }
  }

  activeSegmentIndex = index;
  if (!segments[index].started) segments[index].started = new Date().toISOString();

  document.querySelectorAll('.section-card').forEach((card, i) => {
    card.classList.toggle('active', i === index);
    card.classList.toggle('expanded', i === index);
  });

  document.querySelectorAll('.segment-pill').forEach((pill, i) => {
    pill.classList.toggle('active', i === index);
  });

  document.getElementById(`section-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Timer Logic ──
function startTotalTimer() {
  sessionStartTime = Date.now();
  const savedStart = localStorage.getItem(`sb-session-start-${currentPlan.slug}`);
  if (savedStart) sessionStartTime = parseInt(savedStart);
  else localStorage.setItem(`sb-session-start-${currentPlan.slug}`, sessionStartTime);

  totalInterval = setInterval(() => {
    if (timerPaused) return;

    if (activeSegmentIndex >= 0 && segments[activeSegmentIndex]) {
      const seg = segments[activeSegmentIndex];
      seg.elapsed += 1;

      const progress = getProgress(seg);
      const pClass = getProgressClass(progress);
      const pct = progress !== null ? Math.min(progress * 100, 100) : 0;

      const sectionEl = document.getElementById(`section-time-${activeSegmentIndex}`);
      if (sectionEl) sectionEl.textContent = formatTime(seg.elapsed);

      const sectionProgress = document.getElementById(`section-progress-${activeSegmentIndex}`);
      if (sectionProgress) sectionProgress.style.width = `${pct}%`;

      const sectionCard = document.getElementById(`section-${activeSegmentIndex}`);
      if (sectionCard) {
        sectionCard.classList.remove('warning', 'overtime');
        if (pClass) sectionCard.classList.add(pClass);
      }

      const pillEl = document.getElementById(`pill-time-${activeSegmentIndex}`);
      if (pillEl) {
        const expectedLabel = seg.expectedSeconds > 0 ? ' / ' + formatTime(seg.expectedSeconds) : '';
        pillEl.textContent = formatTime(seg.elapsed) + expectedLabel;
      }

      const pillProgress = document.getElementById(`pill-progress-${activeSegmentIndex}`);
      if (pillProgress) pillProgress.style.width = `${pct}%`;

      const pill = document.querySelectorAll('.segment-pill')[activeSegmentIndex];
      if (pill) {
        pill.classList.remove('warning', 'overtime');
        if (pClass) pill.classList.add(pClass);
      }

      const timers = {};
      segments.forEach(s => { timers[s.id] = s.elapsed; });
      localStorage.setItem(`sb-timers-${currentPlan.slug}`, JSON.stringify(timers));
    }

    const total = segments.reduce((sum, s) => sum + s.elapsed, 0);
    document.getElementById('total-time').textContent = formatTime(total);
  }, 1000);
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n) { return n.toString().padStart(2, '0'); }

// ── Terminal ──
let terminalStarted = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

function setupStartButton() {
  const btn = document.getElementById('start-terminal-btn');
  if (btn) btn.addEventListener('click', startTerminalSession);
}

function startTerminalSession() {
  if (terminalStarted) return;
  terminalStarted = true;
  reconnectAttempts = 0;

  const overlay = document.getElementById('terminal-start-overlay');
  if (overlay) overlay.classList.add('hidden');

  initTerminal();
}

function initTerminal() {
  term = new Terminal({
    fontSize: 14,
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de'
    },
    cursorBlink: true,
    allowProposedApi: true
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById('terminal-container');
  term.open(container);

  requestAnimationFrame(() => {
    fitAddon.fit();
    connectWebSocket(true);
  });

  window.addEventListener('resize', () => { if (fitAddon) fitAddon.fit(); });
}

function buildClaudeCommand() {
  if (sessionContextPath) {
    // Single command: cat context file into claude arg — no timing race
    return `claude "$(cat '${sessionContextPath}')"\n`;
  }
  // Fallback if context file not ready yet
  if (!currentPlan) return 'claude\n';
  const titleMatch = currentPlan.content.match(/^#\s+Study Plan:\s+(.+)/m);
  const subject = titleMatch ? titleMatch[1] : currentPlan.slug.replace(/-/g, ' ');
  return `claude "You are Study Buddy for '${subject}'. Read ~/study-plans/${currentPlan.slug}-study-plan.md then start Phase 2: Knowledge Partner."\n`;
}

function connectWebSocket(autoLaunchClaude) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/terminal`);

  ws.onopen = () => {
    reconnectAttempts = 0;
    const dims = fitAddon.proposeDimensions();
    if (dims) ws.send(`\x01resize:${dims.cols},${dims.rows}`);

    term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(`\x01resize:${cols},${rows}`);
    });

    if (autoLaunchClaude) {
      setTimeout(() => ws.send(buildClaudeCommand()), 400);
    }
  };

  ws.onmessage = (event) => {
    term.write(event.data);
    termTranscript += event.data;
    scheduleStageDetect();
  };

  ws.onclose = () => {
    if (!terminalStarted || !term || term._disposed) return;
    reconnectAttempts++;
    if (reconnectAttempts <= MAX_RECONNECT) {
      term.write('\r\n\x1b[33m[Reconnecting...]\x1b[0m\r\n');
      setTimeout(() => connectWebSocket(false), 2000 * reconnectAttempts);
    } else {
      term.write('\r\n\x1b[31m[Terminal disconnected. Refresh to reconnect.]\x1b[0m\r\n');
    }
  };
}

// ── Terminal Minimize ──
function setupTerminalMinimize() {
  const btn = document.getElementById('terminal-minimize-btn');
  if (btn) btn.addEventListener('click', toggleTerminalMinimize);
}

function toggleTerminalMinimize() {
  terminalMinimized = !terminalMinimized;
  applyTerminalMinimizeState();
}

function applyTerminalMinimizeState() {
  const pane   = document.getElementById('terminal-pane');
  const divider = document.getElementById('divider');
  const btn    = document.getElementById('terminal-minimize-btn');

  if (terminalMinimized) {
    pane.classList.add('minimized');
    divider.classList.add('hidden');
    btn.innerHTML = '&#8593;';
    btn.title = 'Expand terminal';
  } else {
    pane.classList.remove('minimized');
    divider.classList.remove('hidden');
    btn.innerHTML = '&#8595;';
    btn.title = 'Minimize terminal';
    requestAnimationFrame(() => { if (fitAddon) fitAddon.fit(); });
    setTimeout(() => { if (fitAddon) fitAddon.fit(); }, 300);
  }
}

// ── Divider Drag ──
function setupDivider() {
  const divider    = document.getElementById('divider');
  const planPane   = document.getElementById('plan-pane');
  const termPane   = document.getElementById('terminal-pane');
  let isDragging   = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const container = document.getElementById('main-content');
    const rect = container.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0.2, Math.min(0.8, fraction));
    planPane.style.flex = `0 0 ${clamped * 100}%`;
    termPane.style.flex  = `0 0 ${(1 - clamped) * 100}%`;
    if (fitAddon) fitAddon.fit();
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (fitAddon) fitAddon.fit();
    }
  });
}

// ── Notes ──
function setupNotes() {
  document.getElementById('notes-tab')?.addEventListener('click', toggleNotes);
  document.getElementById('notes-close-btn')?.addEventListener('click', () => {
    notesVisible = false;
    document.getElementById('notes-body')?.classList.add('notes-body-hidden');
  });

  const textarea = document.getElementById('notes-area');
  if (textarea) {
    textarea.addEventListener('input', () => {
      if (!currentPlan) return;
      clearTimeout(notesSaveTimeout);
      setNotesSaveStatus('saving…');
      notesSaveTimeout = setTimeout(() => saveNotes(currentPlan.slug, textarea.value), 800);
    });
  }

  // Notes/Reflection sub-tab switching
  document.querySelectorAll('.notes-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.notes-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.notes-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${btn.dataset.tab}-pane`)?.classList.add('active');
    });
  });
}

function toggleNotes() {
  notesVisible = !notesVisible;
  const panel = document.getElementById('notes-panel');
  const body  = document.getElementById('notes-body');
  if (notesVisible) {
    panel.classList.remove('hidden');
    body.classList.remove('notes-body-hidden');
    document.getElementById('notes-area')?.focus();
  } else {
    body.classList.add('notes-body-hidden');
  }
}

async function loadNotes(slug) {
  const panel = document.getElementById('notes-panel');
  panel.classList.remove('hidden'); // always show the tab button

  const body = document.getElementById('notes-body');
  body.classList.add('notes-body-hidden'); // collapsed by default
  notesVisible = false;

  try {
    const res = await fetch(`/api/notes/${slug}`);
    const data = await res.json();
    const textarea = document.getElementById('notes-area');
    if (textarea) {
      textarea.value = data.content || '';
      updateNotesBadge();
    }
  } catch (e) { /* ignore */ }
}

async function saveNotes(slug, content) {
  try {
    await fetch(`/api/notes/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    setNotesSaveStatus('saved');
    setTimeout(() => setNotesSaveStatus(''), 2000);
    updateNotesBadge();
  } catch (e) {
    setNotesSaveStatus('error');
  }
}

function setNotesSaveStatus(msg) {
  const el = document.getElementById('notes-save-status');
  if (el) el.textContent = msg;
}

function updateNotesBadge() {
  const notesContent = (document.getElementById('notes-area')?.value || '').trim();
  const refContent = getReflectionData();
  const hasAny = notesContent.length > 0 ||
    Object.values(refContent).some(v => typeof v === 'string' ? v.trim().length > 0 : v > 0);
  document.getElementById('notes-tab')?.classList.toggle('has-notes', hasAny);
}

// ── Reflection ──
function setupReflection() {
  const fields = ['ref-definitions', 'ref-challenges', 'ref-metaphors', 'ref-qa'];
  fields.forEach(id => {
    document.getElementById(id)?.addEventListener('input', scheduleReflectionSave);
  });

  // Star rating
  const ratingEl = document.getElementById('ref-rating');
  if (ratingEl) {
    ratingEl.querySelectorAll('span').forEach(star => {
      star.addEventListener('click', () => {
        const val = parseInt(star.dataset.val);
        reflectionRating = val === reflectionRating ? 0 : val; // toggle off if same
        renderStars(reflectionRating);
        scheduleReflectionSave();
      });
      star.addEventListener('mouseenter', () => renderStars(parseInt(star.dataset.val), true));
      star.addEventListener('mouseleave', () => renderStars(reflectionRating));
    });
  }
}

function renderStars(value, hover = false) {
  const ratingEl = document.getElementById('ref-rating');
  if (!ratingEl) return;
  ratingEl.querySelectorAll('span').forEach(star => {
    const v = parseInt(star.dataset.val);
    star.classList.toggle('filled', v <= value);
    star.classList.toggle('hover', hover && v <= value);
  });
}

function scheduleReflectionSave() {
  if (!currentPlan) return;
  clearTimeout(reflectionSaveTimeout);
  setNotesSaveStatus('saving…');
  reflectionSaveTimeout = setTimeout(() => saveReflection(currentPlan.slug), 800);
}

function getReflectionData() {
  return {
    definitions: document.getElementById('ref-definitions')?.value || '',
    challenges:  document.getElementById('ref-challenges')?.value  || '',
    metaphors:   document.getElementById('ref-metaphors')?.value   || '',
    qa_notes:    document.getElementById('ref-qa')?.value          || '',
    confidence_rating: reflectionRating
  };
}

async function loadReflection(slug) {
  reflectionRating = 0;
  renderStars(0);
  ['ref-definitions','ref-challenges','ref-metaphors','ref-qa'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  try {
    const res = await fetch(`/api/reflection/${slug}`);
    const data = await res.json();
    if (data.definitions !== undefined)
      document.getElementById('ref-definitions').value = data.definitions;
    if (data.challenges !== undefined)
      document.getElementById('ref-challenges').value  = data.challenges;
    if (data.metaphors !== undefined)
      document.getElementById('ref-metaphors').value   = data.metaphors;
    if (data.qa_notes !== undefined)
      document.getElementById('ref-qa').value          = data.qa_notes;
    reflectionRating = data.confidence_rating || 0;
    renderStars(reflectionRating);
    updateNotesBadge();
  } catch (e) { /* ignore */ }
}

async function saveReflection(slug) {
  const data = getReflectionData();
  data.updated = new Date().toISOString();
  try {
    await fetch(`/api/reflection/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    setNotesSaveStatus('saved');
    setTimeout(() => setNotesSaveStatus(''), 2000);
    updateNotesBadge();
  } catch (e) {
    setNotesSaveStatus('error');
  }
}

// ── Save Session ──
async function saveSession() {
  if (!currentPlan || segments.length === 0) return;
  if (activeSegmentIndex >= 0 && segments[activeSegmentIndex]) {
    segments[activeSegmentIndex].ended = new Date().toISOString();
  }

  const durationMatch = currentPlan.content.match(/\*\*Chosen duration:\*\*\s+(.+)/m);
  const segmentData = {};
  const completedSegments = [];

  segments.forEach(s => {
    segmentData[s.id] = {
      duration: s.elapsed,
      expectedDuration: s.expectedSeconds,
      started: s.started,
      ended: s.ended
    };
    if (s.elapsed > 0) completedSegments.push(s.id);
  });

  // Flush pending saves
  clearTimeout(reflectionSaveTimeout);
  clearTimeout(notesSaveTimeout);
  const reflectionSnapshot = getReflectionData();
  if (currentPlan) await saveReflection(currentPlan.slug);

  // Store final detected stage before saving
  if (currentPlan) {
    const activeSection = segments[activeSegmentIndex]?.title || '';
    await fetch(`/api/stage/${currentPlan.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: currentStage.split(' | ')[0], section: activeSection })
    }).catch(() => {});
  }

  const analytics = {
    subject: currentPlan.slug,
    date: new Date().toISOString(),
    plannedDuration: durationMatch ? durationMatch[1] : '',
    segments: segmentData,
    totalDuration: segments.reduce((sum, s) => sum + s.elapsed, 0),
    totalExpected: segments.reduce((sum, s) => sum + s.expectedSeconds, 0),
    completedSegments,
    reflection: reflectionSnapshot
  };

  // Attach stripped transcript for server-side analysis
  const cleanTranscript = stripAnsi(termTranscript);
  if (cleanTranscript.length > 300) analytics.transcript = cleanTranscript;

  const res = await fetch('/api/analytics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(analytics)
  });
  const result = await res.json();
  showToast(`Session saved: ${result.saved}`);

  // Start polling for async analysis result
  if (cleanTranscript.length > 300) {
    setNotesSaveStatus('📊 analyzing…');
    pollForAnalysis(currentPlan.slug);
  }

  localStorage.removeItem(`sb-timers-${currentPlan.slug}`);
  localStorage.removeItem(`sb-session-start-${currentPlan.slug}`);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ── ANSI stripping ──
function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[mGKHFJsu]/g, '')
    .replace(/\x1B\[[?][0-9;]*[hl]/g, '')
    .replace(/\x1B[()][0-9A-Z]/g, '')
    .replace(/\x1B[=><~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── Phase auto-detection from terminal output ──
const PHASE_ORDER = [
  'Phase 1: Study Plan',
  'Phase 2: Knowledge Partner',
  'Phase 3: Term Review',
  'Phase 3: User Questions',
  'Phase 3: Questions',
  'Phase 3: Hands-on',
  'Phase 4: Wrap-up'
];

function detectPhaseFromTranscript(transcript) {
  const t = stripAnsi(transcript).toLowerCase();

  if (t.includes("here's where you stand") || t.includes("what to revisit") ||
      t.includes("natural next step") || t.includes("wrap-up"))
    return 'Phase 4: Wrap-up';

  if (t.includes("show me what you built") || t.includes("paste your code") ||
      t.includes("hands-on review") || t.includes("3d:"))
    return 'Phase 3: Hands-on';

  if (/\bq[1-9][^0-9]/.test(t) || /\bq10\b/.test(t) ||
      t.includes("10 questions from") || t.includes("understanding questions"))
    return 'Phase 3: Questions';

  if (t.includes("flip it") && t.includes("ask me anything"))
    return 'Phase 3: User Questions';

  if (t.includes("20 terms") || t.includes("your own one-liner") ||
      t.includes("terminology landed") || t.includes("term definitions"))
    return 'Phase 3: Term Review';

  if (t.includes("knowledge partner") || t.includes("ask me anything"))
    return 'Phase 2: Knowledge Partner';

  return null;
}

function scheduleStageDetect() {
  if (!currentPlan) return;
  clearTimeout(stageDetectTimeout);
  stageDetectTimeout = setTimeout(() => {
    const detected = detectPhaseFromTranscript(termTranscript);
    if (!detected) return;

    const currentIdx  = PHASE_ORDER.indexOf(currentStage.split(' | ')[0]);
    const detectedIdx = PHASE_ORDER.indexOf(detected);
    if (detectedIdx <= currentIdx) return; // don't regress

    const activeSection = segments[activeSegmentIndex]?.title || '';
    currentStage = activeSection ? `${detected} | Section: ${activeSection}` : detected;
    updatePhaseIndicator(currentStage);

    if (currentStage !== lastStoredStage) {
      lastStoredStage = currentStage;
      fetch(`/api/stage/${currentPlan.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: detected, section: activeSection })
      }).catch(() => {});
    }
  }, 5000);
}

// ── Phase indicator ──
function setupPhaseIndicator() { /* wired via updatePhaseIndicator calls */ }

function updatePhaseIndicator(stage) {
  const el = document.getElementById('phase-indicator');
  if (!el) return;
  if (!stage) { el.textContent = ''; el.classList.remove('active'); return; }
  // Show short label
  const short = stage.split(' | ')[0].replace('Phase ', 'P').replace(': ', ' · ');
  el.textContent = short;
  el.classList.toggle('active', stage !== 'Phase 1: Study Plan');
}

// ── Analysis polling ──
function pollForAnalysis(slug) {
  if (analysisPollInterval) clearInterval(analysisPollInterval);
  let attempts = 0;

  analysisPollInterval = setInterval(async () => {
    attempts++;
    if (attempts > 20) { // ~60s timeout
      clearInterval(analysisPollInterval);
      setNotesSaveStatus('');
      return;
    }
    try {
      const res = await fetch(`/api/reflection/${slug}`);
      const data = await res.json();
      if (data.auto_analyzed) {
        clearInterval(analysisPollInterval);
        populateReflectionFromAnalysis(data);
        setNotesSaveStatus('');
        showToast('Analysis complete — Reflection tab updated');
        // Auto-open reflection panel on the Reflection tab
        document.querySelector('.notes-tab-btn[data-tab="reflection"]')?.click();
        if (!notesVisible) toggleNotes();
      }
    } catch (e) {}
  }, 3000);
}

function populateReflectionFromAnalysis(data) {
  const fill = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value.trim()) el.value = value;
  };
  if (data.definitions?.length)
    fill('ref-definitions', data.definitions.map(d => `${d.term}: ${d.definition}`).join('\n'));
  if (data.challenges?.length)
    fill('ref-challenges', data.challenges.join('\n'));
  if (data.metaphors?.length)
    fill('ref-metaphors', data.metaphors.join('\n'));
  if (data.qa_insights?.length)
    fill('ref-qa', data.qa_insights.join('\n'));
  updateNotesBadge();
}

// ── Back to plan list ──
function goBack() {
  if (totalInterval) clearInterval(totalInterval);
  totalInterval = null;

  terminalStarted = false;
  if (ws) ws.close();
  if (term) term.dispose();
  term = null; ws = null; fitAddon = null;

  // Clear transcript / stage state
  termTranscript = '';
  currentStage = 'Phase 1: Study Plan';
  sessionContextPath = null;
  lastStoredStage = '';
  if (analysisPollInterval) { clearInterval(analysisPollInterval); analysisPollInterval = null; }
  if (stageDetectTimeout) { clearTimeout(stageDetectTimeout); stageDetectTimeout = null; }
  updatePhaseIndicator('');

  activeSegmentIndex = -1;
  segments = [];
  currentPlan = null;

  // Reset notes/reflection panel state
  notesVisible = false;
  reflectionRating = 0;
  document.getElementById('notes-panel')?.classList.add('hidden');
  document.getElementById('notes-body')?.classList.remove('notes-body-hidden');
  const notesArea = document.getElementById('notes-area');
  if (notesArea) notesArea.value = '';
  ['ref-definitions','ref-challenges','ref-metaphors','ref-qa'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderStars(0);
  // Reset to Notes sub-tab
  document.querySelectorAll('.notes-tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
  document.querySelectorAll('.notes-pane').forEach((p,i) => p.classList.toggle('active', i===0));

  // Reset terminal minimize state
  terminalMinimized = false;
  document.getElementById('terminal-pane')?.classList.remove('minimized');
  document.getElementById('divider')?.classList.remove('hidden');
  const minBtn = document.getElementById('terminal-minimize-btn');
  if (minBtn) { minBtn.innerHTML = '&#8595;'; minBtn.title = 'Minimize terminal'; }

  const overlay = document.getElementById('terminal-start-overlay');
  if (overlay) overlay.classList.remove('hidden');

  document.getElementById('app').classList.add('hidden');
  document.getElementById('plan-selector').classList.remove('hidden');
  loadPlanList();
}
