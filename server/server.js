const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const crypto = require('./crypto-utils');

// ── Init ─────────────────────────────────────────────
db.init();
const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Static file serving for UIs ──────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
app.use('/loader', express.static(path.join(__dirname, '..', 'loader')));

// Rate limiting: 60 requests per minute per IP
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many requests, slow down.' }
});
app.use('/api/', limiter);

// Request IP helper
function getIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}

// Base URL helper (for Linkvertise Target URLs / redirects)
function getBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
}

function callbackUrlFor(req, sessionId, step) {
    return `${getBaseUrl(req)}/api/checkpoint/callback?session=${encodeURIComponent(sessionId)}&step=${step}`;
}

// Verify Linkvertise Anti-Bypass hash server-to-server.
// Returns true if Linkvertise confirms the visitor completed the ad step.
// Test mode: if stored token is exactly "BYPASS", any hash is accepted (local dev only).
async function verifyLinkvertise(apiToken, hash) {
    if (!apiToken) return { ok: false, reason: 'LINKVERTISE_NOT_CONFIGURED' };
    if (apiToken === 'BYPASS') return { ok: true, test: true };
    if (!hash || typeof hash !== 'string' || hash.length < 10) return { ok: false, reason: 'BAD_HASH' };
    try {
        const url = `https://publisher.linkvertise.com/api/v1/anti_bypassing?token=${encodeURIComponent(apiToken)}&hash=${encodeURIComponent(hash)}`;
        const res = await fetch(url, { method: 'POST' });
        const text = (await res.text()).trim().toUpperCase();
        if (text.includes('TRUE')) return { ok: true };
        return { ok: false, reason: 'NOT_VERIFIED' };
    } catch (e) {
        return { ok: false, reason: 'VERIFY_REQUEST_FAILED' };
    }
}

// Admin API key auth middleware
function requireAdmin(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing X-API-Key header' });
    }
    const project = db.getProjectByApiKey(apiKey);
    if (!project) {
        return res.status(401).json({ error: 'INVALID_API_KEY', message: 'Invalid API key' });
    }
    req.project = project;
    next();
}

// ══════════════════════════════════════════════════════
//  PUBLIC ROUTES — Client Loader
// ══════════════════════════════════════════════════════

// POST /api/auth — Authenticate license key + HWID, return encrypted script
app.post('/api/auth', (req, res) => {
    const { key, hwid, version, checkpoint_token } = req.body;
    const ip = getIP(req);
    const ua = req.headers['user-agent'] || '';

    if (!key || !hwid) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'key and hwid are required' });
    }

    // Find the key
    const keyRecord = db.getKeyByValue(key);
    if (!keyRecord) {
        return res.status(403).json({ error: 'INVALID_KEY', message: 'License key not found' });
    }

    const project = db.getProject(keyRecord.project_id);
    if (!project) {
        return res.status(403).json({ error: 'PROJECT_NOT_FOUND', message: 'Project does not exist' });
    }

    // Check kill switch
    if (project.kill_switch) {
        db.logAuth(keyRecord.id, project.id, hwid, ip, 'PROJECT_KILLED', ua);
        return res.status(403).json({ error: 'PROJECT_KILLED', message: 'This project has been disabled by the developer' });
    }

    // Check if key is active
    if (!keyRecord.is_active) {
        db.logAuth(keyRecord.id, project.id, hwid, ip, 'KEY_DISABLED', ua);
        return res.status(403).json({ error: 'KEY_DISABLED', message: 'This key has been disabled' });
    }

    // Check if key is blacklisted
    if (keyRecord.is_blacklisted) {
        db.logAuth(keyRecord.id, project.id, hwid, ip, 'KEY_BLACKLISTED', ua);
        return res.status(403).json({ error: 'KEY_BLACKLISTED', message: 'This key has been blacklisted' });
    }

    // Check expiry
    if (keyRecord.expires_at) {
        const expiresAt = new Date(keyRecord.expires_at);
        if (expiresAt < new Date()) {
            db.logAuth(keyRecord.id, project.id, hwid, ip, 'KEY_EXPIRED', ua);
            return res.status(403).json({ error: 'KEY_EXPIRED', message: 'This key has expired' });
        }
    }

    // Check max uses
    if (keyRecord.max_uses > 0 && keyRecord.use_count >= keyRecord.max_uses) {
        db.logAuth(keyRecord.id, project.id, hwid, ip, 'MAX_USES_REACHED', ua);
        return res.status(403).json({ error: 'MAX_USES_REACHED', message: 'This key has reached its maximum usage limit' });
    }

    // HWID binding logic
    if (!keyRecord.hwid) {
        // First use: bind HWID
        db.updateKey(keyRecord.id, { hwid: hwid });
    } else if (keyRecord.hwid !== hwid) {
        // HWID mismatch
        db.logAuth(keyRecord.id, project.id, hwid, ip, 'HWID_MISMATCH', ua);
        return res.status(403).json({ error: 'HWID_MISMATCH', message: 'This key is locked to a different device' });
    }

    // ── Checkpoint gate (Linkvertise) ──
    if (db.isCheckpointRequired(project)) {
        const valid = db.getValidCheckpoint(project.id, { hwid, key_value: key, checkpoint_token });
        if (!valid) {
            db.logAuth(keyRecord.id, project.id, hwid, ip, 'CHECKPOINT_REQUIRED', ua);
            const steps = db.parseSteps(project);
            return res.status(403).json({
                error: 'CHECKPOINT_REQUIRED',
                message: 'Complete the checkpoint steps to continue',
                checkpoint: {
                    required: true,
                    project_id: project.id,
                    total_steps: steps.length,
                    cooldown_hours: project.checkpoint_cooldown_hours || 24
                }
            });
        }
    }

    // Check if script exists
    if (!project.script_data) {
        db.logAuth(keyRecord.id, project.id, hwid, ip, 'NO_SCRIPT', ua);
        return res.status(404).json({ error: 'NO_SCRIPT', message: 'No script uploaded for this project' });
    }

    // ── Success: encrypt and deliver script ──
    const nonce = crypto.generateNonce();
    const derivedKey = crypto.deriveKey(project.master_key, hwid, nonce);

    // Apply constant obfuscation layer before encryption
    const obfuscated = crypto.obfuscateConstants(project.script_data);
    const encrypted = crypto.encrypt(obfuscated, derivedKey);

    // Update key usage
    db.updateKey(keyRecord.id, {
        use_count: keyRecord.use_count + 1,
        last_ip: ip,
        last_used: new Date().toISOString()
    });

    // Log success
    db.logAuth(keyRecord.id, project.id, hwid, ip, 'SUCCESS', ua);

    res.json({
        status: 'OK',
        nonce: nonce,
        payload: encrypted,
        version: project.version,
        version_hash: project.version_hash
    });
});

// GET /api/version/:projectId — Check latest version
app.get('/api/version/:projectId', (req, res) => {
    const project = db.getProject(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    }
    const steps = db.parseSteps(project);
    res.json({
        version: project.version,
        version_hash: project.version_hash,
        kill_switch: !!project.kill_switch,
        checkpoint_required: db.isCheckpointRequired(project),
        checkpoint_steps: steps.length,
        checkpoint_cooldown_hours: project.checkpoint_cooldown_hours || 24
    });
});

// ══════════════════════════════════════════════════════
//  CHECKPOINT ROUTES — Linkvertise-gated steps
// ══════════════════════════════════════════════════════

// GET /api/checkpoint/config/:projectId — Public minimal config for checkpoint page
app.get('/api/checkpoint/config/:projectId', (req, res) => {
    const project = db.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    const steps = db.parseSteps(project);
    res.json({
        project_id: project.id,
        project_name: project.name,
        checkpoint_enabled: !!project.checkpoint_enabled && steps.length > 0,
        total_steps: steps.length,
        cooldown_hours: project.checkpoint_cooldown_hours || 24
    });
});

// GET /api/checkpoint/targets/:projectId — Admin: static Target URLs to paste into Linkvertise
app.get('/api/checkpoint/targets/:projectId', requireAdmin, (req, res) => {
    const project = db.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    const steps = db.parseSteps(project);
    const base = getBaseUrl(req);
    res.json({
        targets: steps.map((_, i) => `${base}/api/checkpoint/callback?project=${project.id}&step=${i}`)
    });
});

// POST /api/checkpoint/start — Begin (or resume) a checkpoint session
// Body: { project_id, hwid, key? } → { session_id, total_steps, current_step, link_url, callback_url }
app.post('/api/checkpoint/start', (req, res) => {
    const { project_id, hwid, key } = req.body || {};
    if (!project_id || !hwid) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'project_id and hwid are required' });
    }
    const project = db.getProject(project_id);
    if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    const steps = db.parseSteps(project);
    if (!project.checkpoint_enabled || steps.length === 0) {
        return res.status(400).json({ error: 'CHECKPOINT_DISABLED', message: 'Checkpoint is not enabled for this project' });
    }

    const session = db.createCheckpointSession(project_id, { hwid, key_value: key || null, ip: getIP(req) });
    const step = 0;
    res.json({
        session_id: session.id,
        total_steps: steps.length,
        current_step: step,
        link_url: steps[step],
        callback_url: callbackUrlFor(req, session.id, step),
        // Static per-step Target URLs (paste these into Linkvertise → Target URL)
        target_urls: steps.map((_, i) => `${getBaseUrl(req)}/api/checkpoint/callback?project=${project_id}&step=${i}`),
        cooldown_hours: project.checkpoint_cooldown_hours || 24
    });
});

// GET /api/checkpoint/status — Poll session progress / token validity
// Query: ?session=<id>  OR  ?project_id=<id>&hwid=<h>&key=<k>
app.get('/api/checkpoint/status', (req, res) => {
    const { session, project_id, hwid, key, checkpoint_token } = req.query;

    if (session) {
        const s = db.getCheckpointSession(session);
        if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
        const project = db.getProject(s.project_id);
        const steps = db.parseSteps(project || {});
        const done = s.verified_steps >= steps.length;
        const validToken = s.checkpoint_token && s.token_expires_at && new Date(s.token_expires_at) > new Date();
        return res.json({
            session_id: s.id,
            project_id: s.project_id,
            total_steps: steps.length,
            verified_steps: s.verified_steps,
            current_step: Math.min(s.verified_steps, Math.max(steps.length - 1, 0)),
            next_link: done ? null : steps[Math.min(s.verified_steps, steps.length - 1)],
            next_callback: done ? null : callbackUrlFor(req, s.id, Math.min(s.verified_steps, steps.length - 1)),
            done,
            checkpoint_token: validToken ? s.checkpoint_token : null,
            token_expires_at: validToken ? s.token_expires_at : null
        });
    }

    if (project_id && (hwid || key)) {
        const project = db.getProject(project_id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        if (!db.isCheckpointRequired(project)) {
            return res.json({ required: false, completed: true });
        }
        const valid = db.getValidCheckpoint(project_id, { hwid, key_value: key, checkpoint_token });
        if (valid) {
            return res.json({
                required: true, completed: true,
                checkpoint_token: valid.checkpoint_token,
                token_expires_at: valid.token_expires_at,
                total_steps: db.parseSteps(project).length
            });
        }
        return res.json({ required: true, completed: false, total_steps: db.parseSteps(project).length });
    }

    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Provide ?session= or ?project_id=&hwid=' });
});

// GET /api/checkpoint/callback — Linkvertise Target URL. Verifies Anti-Bypass hash.
// Paste the STATIC per-step URL into Linkvertise ("Target URL"):
//   https://HOST/api/checkpoint/callback?project=<id>&step=<n>
// Linkvertise appends ?hash=<64char> when redirecting here.
// Attribution: latest pending session for that project+step from the same IP (30 min window).
// Direct mode (test/manual verify): ?session=<id>&step=<n>&hash=<h> still works.
app.get('/api/checkpoint/callback', async (req, res) => {
    const { session, project, project_id, step, hash } = req.query;
    const loaderPage = (s, extra = '') => `${getBaseUrl(req)}/loader/checkpoint.html?session=${encodeURIComponent(s)}${extra}`;
    const failPage = (msg) => res.status(400).send(
        `<body style="background:#111215;color:#e5e7eb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h3>Checkpoint verification failed</h3><p style="color:#6b7280">${msg}</p><p style="color:#6b7280">Return to the previous tab — your progress is saved automatically.</p></div></body>`);

    const stepIdx = Math.max(0, parseInt(step ?? 0) || 0);
    const pid = project || project_id;

    // ── Direct mode: session id present ──
    if (session) {
        const s = db.getCheckpointSession(session);
        if (!s) return failPage('Session not found. Start over from the checkpoint page.');
        const proj = db.getProject(s.project_id);
        if (!proj) return failPage('Project not found.');
        const steps = db.parseSteps(proj);
        if (stepIdx !== s.verified_steps) {
            return res.redirect(loaderPage(s.id, `&error=wrong_step`));
        }
        const check = await verifyLinkvertise(proj.linkvertise_token, hash);
        if (!check.ok) {
            db.logCheckpointAttempt(s.id, s.project_id, stepIdx, String(hash || ''), check.reason || 'NOT_VERIFIED');
            if (check.reason === 'LINKVERTISE_NOT_CONFIGURED') {
                return failPage('Linkvertise API token not set. Ask the developer to paste it in Dashboard → Project → Checkpoint.');
            }
            return res.redirect(loaderPage(s.id, `&error=verify_failed`));
        }
        const { session: updated, done } = db.markStepVerified(s.id, stepIdx, String(hash), proj.checkpoint_cooldown_hours);
        if (done) return res.redirect(loaderPage(s.id, `&done=1`));
        return res.redirect(loaderPage(updated.id, `&step=${updated.verified_steps}`));
    }

    // ── Static-target mode: no session, attribute by IP ──
    if (!pid) return failPage('Missing project. Check the Target URL in Linkvertise dashboard.');
    const proj = db.getProject(pid);
    if (!proj) return failPage('Project not found.');
    const check = await verifyLinkvertise(proj.linkvertise_token, hash);
    if (!check.ok) {
        db.logCheckpointAttempt(null, pid, stepIdx, String(hash || ''), check.reason || 'NOT_VERIFIED');
        if (check.reason === 'LINKVERTISE_NOT_CONFIGURED') {
            return failPage('Linkvertise API token not set. Ask the developer to paste it in Dashboard → Project → Checkpoint.');
        }
        return failPage('Linkvertise could not verify this visit. Go back and complete the step again.');
    }
    const ip = getIP(req);
    const claimed = db.claimCheckpointByIP(pid, stepIdx, String(hash), ip);
    if (!claimed) {
        return failPage('Verified with Linkvertise, but no waiting session found for your network. Go back — if your checkpoint tab is open, it will pick this up automatically.');
    }
    // Success landing — tab can be closed; the checkpoint tab polls and advances.
    return res.send(
        `<body style="background:#111215;color:#e5e7eb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><div style="font-size:40px">✓</div><h3>Step ${stepIdx + 1} complete</h3><p style="color:#6b7280">Return to the previous tab to continue.</p><script>setTimeout(()=>window.close(),4000)</script></div></body>`);
});

// POST /api/keys/claim — Self-serve key after checkpoint (flow A: gate key issuing)
// Body: { project_id, hwid, checkpoint_token }
app.post('/api/keys/claim', (req, res) => {
    const { project_id, hwid, checkpoint_token } = req.body || {};
    const ip = getIP(req);
    const ua = req.headers['user-agent'] || '';
    if (!project_id || !hwid || !checkpoint_token) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'project_id, hwid and checkpoint_token are required' });
    }
    const project = db.getProject(project_id);
    if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    if (project.kill_switch) return res.status(403).json({ error: 'PROJECT_KILLED' });
    if (!db.isCheckpointRequired(project)) {
        return res.status(400).json({ error: 'CHECKPOINT_DISABLED', message: 'This project does not require checkpoint' });
    }
    const valid = db.getValidCheckpoint(project_id, { hwid, checkpoint_token });
    if (!valid) {
        db.logAuth(null, project_id, hwid, ip, 'CHECKPOINT_FAILED', ua);
        return res.status(403).json({ error: 'CHECKPOINT_INVALID', message: 'Checkpoint token invalid or expired. Complete the steps again.' });
    }
    // One key per HWID: return existing unbound/bound key instead of minting duplicates
    const existing = db.listKeys(project_id, 500, 0).find(k => k.hwid === hwid);
    if (existing) return res.json({ key: existing.key_value, reused: true, checkpoint_token });
    const created = db.createKey(project_id, { hwid, note: 'checkpoint-claim' });
    db.logAuth(created.id, project_id, hwid, ip, 'SUCCESS', ua + ' [checkpoint-claim]');
    res.status(201).json({ key: created.key_value, reused: false, checkpoint_token });
});


// ══════════════════════════════════════════════════════
//  ADMIN ROUTES — Dashboard API (require X-API-Key)
// ══════════════════════════════════════════════════════

// ── Projects ─────────────────────────────────────────

// POST /api/projects — Create a new project
app.post('/api/projects', (req, res) => {
    const { name, description } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'MISSING_NAME', message: 'Project name is required' });
    }
    const project = db.createProject(name, description || '');
    res.status(201).json(project);
});

// GET /api/projects — List all projects
app.get('/api/projects', requireAdmin, (req, res) => {
    const projects = db.listProjects();
    res.json(projects);
});

// GET /api/projects/:id — Get single project
app.get('/api/projects/:id', requireAdmin, (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(project);
});

// PATCH /api/projects/:id — Update project (kill switch, script, version)
app.patch('/api/projects/:id', requireAdmin, (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'NOT_FOUND' });

    const updates = {};
    const allowed = ['name', 'description', 'script_data', 'version', 'kill_switch', 'max_keys',
        'checkpoint_enabled', 'checkpoint_steps', 'linkvertise_token', 'checkpoint_cooldown_hours'];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            updates[key] = req.body[key];
        }
    }

    // Normalize checkpoint fields
    if (updates.checkpoint_steps !== undefined) {
        let arr = updates.checkpoint_steps;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
        if (!Array.isArray(arr)) arr = [];
        arr = arr.map(s => String(s || '').trim()).filter(Boolean).slice(0, 5);
        updates.checkpoint_steps = JSON.stringify(arr);
    }
    if (updates.checkpoint_enabled !== undefined) {
        updates.checkpoint_enabled = updates.checkpoint_enabled ? 1 : 0;
    }
    if (updates.checkpoint_cooldown_hours !== undefined) {
        const n = Math.max(1, Math.min(720, parseInt(updates.checkpoint_cooldown_hours) || 24));
        updates.checkpoint_cooldown_hours = n;
    }

    // Auto-hash script content when updated
    if (updates.script_data) {
        updates.version_hash = crypto.hashScript(updates.script_data);
    }

    const updated = db.updateProject(req.params.id, updates);
    res.json(updated);
});

// DELETE /api/projects/:id — Delete project + all keys
app.delete('/api/projects/:id', requireAdmin, (req, res) => {
    db.deleteProject(req.params.id);
    res.json({ status: 'deleted' });
});

// ── Keys ─────────────────────────────────────────────

// POST /api/keys/:projectId — Create key(s)
app.post('/api/keys/:projectId', requireAdmin, (req, res) => {
    const project = db.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

    const { count, note, expires_at, max_uses } = req.body;

    if (count && count > 1) {
        // Bulk create
        const maxAllowed = Math.min(count, 500);
        const keys = db.createBulkKeys(req.params.projectId, maxAllowed, { note, expires_at, max_uses });
        return res.status(201).json({ created: keys.length, keys });
    }

    // Single create
    const key = db.createKey(req.params.projectId, { note, expires_at, max_uses, ...req.body });
    res.status(201).json(key);
});

// GET /api/keys/:projectId — List keys
app.get('/api/keys/:projectId', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const keys = db.listKeys(req.params.projectId, limit, offset);
    const total = db.countKeys(req.params.projectId);
    res.json({ total, keys });
});

// PATCH /api/keys/update/:keyId — Update key
app.patch('/api/keys/update/:keyId', requireAdmin, (req, res) => {
    const key = db.getKey(req.params.keyId);
    if (!key) return res.status(404).json({ error: 'KEY_NOT_FOUND' });

    const updated = db.updateKey(req.params.keyId, req.body);
    res.json(updated);
});

// POST /api/keys/reset-hwid/:keyId — Reset HWID
app.post('/api/keys/reset-hwid/:keyId', requireAdmin, (req, res) => {
    const key = db.getKey(req.params.keyId);
    if (!key) return res.status(404).json({ error: 'KEY_NOT_FOUND' });

    const updated = db.resetHwid(req.params.keyId);
    res.json({ status: 'hwid_reset', key: updated });
});

// DELETE /api/keys/:keyId — Delete key
app.delete('/api/keys/:keyId', requireAdmin, (req, res) => {
    db.deleteKey(req.params.keyId);
    res.json({ status: 'deleted' });
});

// ── Logs & Stats ─────────────────────────────────────

// GET /api/logs/:projectId — Get auth logs
app.get('/api/logs/:projectId', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const logs = db.getAuthLogs(req.params.projectId, limit);
    res.json(logs);
});

// GET /api/stats/:projectId — Get project stats
app.get('/api/stats/:projectId', requireAdmin, (req, res) => {
    const project = db.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

    const stats = db.getProjectStats(req.params.projectId);
    res.json(stats);
});

// ── Health ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start ────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  ┌──────────────────────────────────────┐`);
    console.log(`  │  Luaction API — v1.0.0        │`);
    console.log(`  │  Running on http://localhost:${PORT}    │`);
    console.log(`  └──────────────────────────────────────┘\n`);
});

module.exports = app;


