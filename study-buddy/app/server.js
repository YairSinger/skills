const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/terminal' });

const PLANS_DIR = path.join(os.homedir(), 'study-plans');
const ANALYTICS_DIR = path.join(__dirname, 'analytics');

// ── Plan resolver: prefer HTML, fall back to MD ──────────────────────────────
function findPlan(slug) {
  const htmlPath = path.join(PLANS_DIR, `${slug}-study-plan.html`);
  const mdPath   = path.join(PLANS_DIR, `${slug}-study-plan.md`);
  if (fs.existsSync(htmlPath)) return { path: htmlPath, kind: 'html' };
  if (fs.existsSync(mdPath))   return { path: mdPath,   kind: 'md' };
  return null;
}

function readPlan(slug) {
  const p = findPlan(slug);
  if (!p) return null;
  return { ...p, content: fs.readFileSync(p.path, 'utf-8') };
}

function extractPlanMeta(content, kind) {
  if (kind === 'html') {
    const attr = (re) => (content.match(re) || [])[1] || '';
    const title    = attr(/<html[^>]*\sdata-plan-title="([^"]+)"/i)
                   || attr(/<title[^>]*>Study Plan:\s*([^<]+)<\/title>/i)
                   || attr(/<title[^>]*>([^<]+)<\/title>/i);
    const date     = attr(/<html[^>]*\sdata-plan-date="([^"]+)"/i);
    const duration = attr(/<html[^>]*\sdata-plan-duration="([^"]+)"/i);
    const stage    = attr(/<meta\s+name="study-stage"\s+content="([^"]+)"/i);
    return { title: title.trim(), date: date.trim(), duration: duration.trim(), stage: stage.trim() };
  }
  // markdown
  const m = (re) => (content.match(re) || [])[1] || '';
  return {
    title:    m(/^#\s+Study Plan:\s+(.+)/m).trim(),
    date:     m(/\*\*Date:\*\*\s+(.+)/m).trim(),
    duration: m(/\*\*Chosen duration:\*\*\s+(.+)/m).trim(),
    stage:    m(/\*\*Current Stage:\*\*\s*(.+)/m).trim(),
  };
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionContext(slug, planContent, kind, planFilePath) {
  const meta = extractPlanMeta(planContent, kind);
  const subject = meta.title || slug.replace(/-/g, ' ');
  const stage = meta.stage || 'Phase 1: Study Plan';

  let instruction = `Move directly into Phase 2: Knowledge Partner. Welcome the student and invite them to ask anything about ${subject}.`;
  if (stage.includes('Phase 2'))
    instruction = `Resume Phase 2: Knowledge Partner. You are in open Q+A mode about ${subject}. Answer with precision and depth.`;
  else if (stage.includes('Term Review') || stage.includes('3a'))
    instruction = `Resume Phase 3, Step 3a: ask the student to give their own one-liner for each of the 20 terms from the plan.`;
  else if (stage.includes('User Questions') || stage.includes('3b'))
    instruction = `Resume Phase 3, Step 3b: the student asks you questions to clarify anything that is still fuzzy.`;
  else if (stage.includes('Questions') || stage.includes('3c'))
    instruction = `Resume Phase 3, Step 3c: work through Q1-Q10 from the plan, evaluating genuine understanding.`;
  else if (stage.includes('Hands-on') || stage.includes('3d'))
    instruction = `Resume Phase 3, Step 3d: ask the student to show their work on the hands-on tasks.`;
  else if (stage.includes('Phase 4') || stage.includes('Wrap'))
    instruction = `Resume Phase 4: Wrap-up. Give a 3-5 sentence honest summary of where the student stands.`;

  // No double-quotes or backticks — the file is cat'd into a shell arg
  return [
    `You are running the Study Buddy skill.`,
    `Subject: ${subject}`,
    `Study plan file: ${planFilePath}`,
    `Current stage: ${stage}`,
    ``,
    `FIRST: Read the study plan at ${planFilePath} before you say anything.`,
    ``,
    `THEN: ${instruction}`,
    ``,
    `Study Buddy phase reference (for context):`,
    `  Phase 2  - Open Q+A. Answer with precision. Connect answers to plan concepts.`,
    `  Phase 3a - Student defines the 20 terms in their own words. You evaluate each.`,
    `  Phase 3b - Student asks you questions. Clarify fuzzy areas.`,
    `  Phase 3c - Q1-Q10 from the plan. Evaluate genuine understanding, not recall.`,
    `  Phase 3d - Hands-on review. Student shows their work for each task.`,
    `  Phase 4  - Honest 3-5 sentence wrap-up. What to revisit. What comes next.`,
  ].join('\n');
}

function updateStageInPlan(slug, stageValue) {
  const p = findPlan(slug);
  if (!p) return false;
  let content = fs.readFileSync(p.path, 'utf-8');

  if (p.kind === 'html') {
    const escaped = stageValue.replace(/"/g, '&quot;');
    if (/<meta\s+name="study-stage"/i.test(content)) {
      content = content.replace(
        /<meta\s+name="study-stage"\s+content="[^"]*"\s*\/?>/i,
        `<meta name="study-stage" content="${escaped}">`
      );
    } else {
      content = content.replace(
        /<\/head>/i,
        `  <meta name="study-stage" content="${escaped}">\n</head>`
      );
    }
  } else {
    if (content.includes('**Current Stage:**')) {
      content = content.replace(/\*\*Current Stage:\*\*[^\n]*/m, `**Current Stage:** ${stageValue}`);
    } else {
      content = content.replace(
        /(\*\*Chosen duration:\*\*[^\n]*\n)/,
        `$1**Current Stage:** ${stageValue}\n`
      );
    }
  }
  fs.writeFileSync(p.path, content);
  return true;
}

function appendSessionSummaryToPlan(slug, analysis, sessionDate) {
  const p = findPlan(slug);
  if (!p) return;

  const d = new Date(sessionDate);
  const dateStr = isNaN(d.getTime())
    ? new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  if (p.kind === 'html') {
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts = [`<section class="session-summary" style="margin:24px 0;padding:16px 20px;border-left:3px solid #7c6af7;background:rgba(124,106,247,0.08);border-radius:0 8px 8px 0;">`];
    parts.push(`<h2 style="margin:0 0 8px;font-size:1rem;color:#fff;">Session Summary — ${esc(dateStr)}</h2>`);
    if (analysis.summary) parts.push(`<p>${esc(analysis.summary)}</p>`);
    const block = (title, items, render) => {
      if (!items?.length) return;
      parts.push(`<p style="margin-top:10px;"><strong>${title}:</strong></p><ul>`);
      for (const it of items) parts.push(`<li>${render(it)}</li>`);
      parts.push(`</ul>`);
    };
    block('My definitions', analysis.definitions, d => `<strong>${esc(d.term)}</strong>: ${esc(d.definition)}`);
    block('Challenges',     analysis.challenges,  c => esc(c));
    block('Metaphors & mental models', analysis.metaphors, m => esc(m));
    block('Q+A insights',   analysis.qa_insights, q => esc(q));
    parts.push(`</section>`);
    const block_html = parts.join('\n');

    let content = fs.readFileSync(p.path, 'utf-8');
    if (/<\/body>/i.test(content)) {
      content = content.replace(/<\/body>/i, `${block_html}\n</body>`);
    } else {
      content += '\n' + block_html;
    }
    fs.writeFileSync(p.path, content);
    return;
  }

  // Markdown
  const lines = [`\n\n---\n\n## Session Summary — ${dateStr}\n`];
  if (analysis.summary) lines.push(`${analysis.summary}\n`);
  if (analysis.definitions?.length) {
    lines.push('\n**My definitions:**');
    for (const d of analysis.definitions) lines.push(`- **${d.term}**: ${d.definition}`);
  }
  if (analysis.challenges?.length) {
    lines.push('\n**Challenges:**');
    for (const c of analysis.challenges) lines.push(`- ${c}`);
  }
  if (analysis.metaphors?.length) {
    lines.push('\n**Metaphors & mental models:**');
    for (const m of analysis.metaphors) lines.push(`- ${m}`);
  }
  if (analysis.qa_insights?.length) {
    lines.push('\n**Q+A insights:**');
    for (const q of analysis.qa_insights) lines.push(`- ${q}`);
  }
  fs.appendFileSync(p.path, lines.join('\n') + '\n');
}

async function analyzeSessionTranscript(transcript, subject) {
  const clean = transcript.slice(-7000);

  const prompt =
    `Analyze this study session transcript. The student was learning "${subject}" via Q+A with an AI tutor.\n\n` +
    `Return ONLY a raw JSON object (no markdown fences, no preamble):\n` +
    `{\n` +
    `  "definitions": [{"term": "term name", "definition": "the student's own words exactly"}],\n` +
    `  "challenges": ["specific concept or question the student found hard or got wrong"],\n` +
    `  "metaphors": ["analogy or mental model from the student's own messages"],\n` +
    `  "qa_insights": ["one-line note about an exchange that revealed something about their understanding"],\n` +
    `  "summary": "2-3 honest sentences: what they grasped and what still needs work"\n` +
    `}\n\n` +
    `Rules: extract only from the STUDENT's messages, not the tutor's. Use [] for empty fields.\n\n` +
    `TRANSCRIPT:\n${clean}`;

  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', prompt], {
      env: process.env,
      cwd: os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', () => {});

    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 60000);

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const m = out.match(/\{[\s\S]*\}/);
        resolve(m ? JSON.parse(m[0]) : null);
      } catch { resolve(null); }
    });
  });
}

async function analyzeAndStore(slug, transcript, sessionDate) {
  const p = readPlan(slug);
  const planContent = p ? p.content : '';
  const meta = p ? extractPlanMeta(planContent, p.kind) : { title: '' };
  const subject = meta.title || slug.replace(/-/g, ' ');

  const analysis = await analyzeSessionTranscript(transcript, subject);
  if (!analysis) return;

  // Write / merge reflection JSON
  const refPath = path.join(PLANS_DIR, `${slug}-reflection.json`);
  const existing = fs.existsSync(refPath)
    ? JSON.parse(fs.readFileSync(refPath, 'utf-8'))
    : {};
  fs.writeFileSync(refPath, JSON.stringify({
    ...existing, ...analysis,
    updated: new Date().toISOString(),
    auto_analyzed: true
  }, null, 2));

  // Append summary section to plan file
  appendSessionSummaryToPlan(slug, analysis, sessionDate);
}

// ── API ───────────────────────────────────────────────────────────────────────

// List plans — prefer HTML over MD when both exist for a slug
app.get('/api/plans', (req, res) => {
  try {
    const bySlug = new Map();
    for (const f of fs.readdirSync(PLANS_DIR)) {
      let slug = null, kind = null;
      if (f.endsWith('-study-plan.html')) { slug = f.replace('-study-plan.html', ''); kind = 'html'; }
      else if (f.endsWith('-study-plan.md')) { slug = f.replace('-study-plan.md', ''); kind = 'md'; }
      else continue;
      // HTML wins if both present
      if (bySlug.has(slug) && bySlug.get(slug).kind === 'html') continue;
      const content = fs.readFileSync(path.join(PLANS_DIR, f), 'utf-8');
      const meta = extractPlanMeta(content, kind);
      bySlug.set(slug, {
        slug, filename: f, kind,
        title: meta.title || slug,
        date: meta.date,
        duration: meta.duration
      });
    }
    const files = Array.from(bySlug.values()).sort((a, b) => b.date.localeCompare(a.date));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get plan (HTML or MD)
app.get('/api/plan/:slug', (req, res) => {
  const p = readPlan(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Plan not found' });
  const meta = extractPlanMeta(p.content, p.kind);
  res.json({ slug: req.params.slug, kind: p.kind, content: p.content, meta });
});

// Session context — writes /tmp context file, returns its path + current stage
app.get('/api/session-context/:slug', (req, res) => {
  const p = readPlan(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Plan not found' });
  const ctx = generateSessionContext(req.params.slug, p.content, p.kind, p.path);
  const tmpPath = path.join(os.tmpdir(), `sb-ctx-${req.params.slug}.txt`);
  fs.writeFileSync(tmpPath, ctx);
  const meta = extractPlanMeta(p.content, p.kind);
  res.json({ contextPath: tmpPath, stage: meta.stage || 'Phase 1: Study Plan' });
});

// Update stage in plan file + regenerate context file
app.post('/api/stage/:slug', (req, res) => {
  const { stage, section } = req.body;
  const value = section ? `${stage} | Section: ${section}` : stage;
  updateStageInPlan(req.params.slug, value);

  // Regenerate context file so next launch picks it up
  const p = readPlan(req.params.slug);
  if (p) {
    const ctx = generateSessionContext(req.params.slug, p.content, p.kind, p.path);
    try { fs.writeFileSync(path.join(os.tmpdir(), `sb-ctx-${req.params.slug}.txt`), ctx); } catch {}
  }
  res.json({ updated: true, value });
});

// Analytics — strip transcript before storing, fire async analysis
app.post('/api/analytics', (req, res) => {
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  const { transcript, ...data } = req.body;
  data.sessionId = data.sessionId || uuidv4();
  const filename = `${data.subject}-${new Date().toISOString().slice(0, 10)}-${data.sessionId.slice(0, 8)}.json`;
  fs.writeFileSync(path.join(ANALYTICS_DIR, filename), JSON.stringify(data, null, 2));
  res.json({ saved: filename });

  if (transcript && transcript.length > 300) {
    analyzeAndStore(data.subject, transcript, data.date).catch(err => {
      console.error('[analysis]', err.message);
    });
  }
});

// All analytics
app.get('/api/analytics', (req, res) => {
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  try {
    const sessions = fs.readdirSync(ANALYTICS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(ANALYTICS_DIR, f), 'utf-8')));
    res.json(sessions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Analytics by subject
app.get('/api/analytics/:subject', (req, res) => {
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  try {
    const sessions = fs.readdirSync(ANALYTICS_DIR)
      .filter(f => f.startsWith(req.params.subject) && f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(ANALYTICS_DIR, f), 'utf-8')));
    res.json(sessions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Notes
app.get('/api/notes/:slug', (req, res) => {
  const fp = path.join(PLANS_DIR, `${req.params.slug}-notes.md`);
  res.json({ content: fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '' });
});
app.post('/api/notes/:slug', (req, res) => {
  fs.writeFileSync(path.join(PLANS_DIR, `${req.params.slug}-notes.md`), req.body.content || '');
  res.json({ saved: true });
});

// Reflection
app.get('/api/reflection/:slug', (req, res) => {
  const fp = path.join(PLANS_DIR, `${req.params.slug}-reflection.json`);
  if (!fs.existsSync(fp)) return res.json({});
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf-8'))); } catch { res.json({}); }
});
app.post('/api/reflection/:slug', (req, res) => {
  fs.writeFileSync(
    path.join(PLANS_DIR, `${req.params.slug}-reflection.json`),
    JSON.stringify(req.body, null, 2)
  );
  res.json({ saved: true });
});

// ── Terminal WebSocket ────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const shell = process.env.SHELL || '/bin/zsh';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80, rows: 24,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' }
  });

  ptyProcess.onData(data => {
    try { ws.send(data); } catch {}
  });

  ws.on('message', msg => {
    const str = msg.toString();
    if (str.startsWith('\x01resize:')) {
      const [cols, rows] = str.slice(8).split(',').map(Number);
      if (cols > 0 && rows > 0) ptyProcess.resize(cols, rows);
      return;
    }
    ptyProcess.write(str);
  });

  ws.on('close', () => { ptyProcess.kill(); });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`Study Buddy app running at http://localhost:${PORT}`);
});
