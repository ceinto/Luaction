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
    const { key, hwid, version } = req.body;
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
    res.json({
        version: project.version,
        version_hash: project.version_hash,
        kill_switch: !!project.kill_switch
    });
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
app.get('/api/projects', (req, res) => {
    const projects = db.listProjects();
    res.json(projects);
});

// GET /api/projects/:id — Get single project
app.get('/api/projects/:id', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(project);
});

// PATCH /api/projects/:id — Update project (kill switch, script, version)
app.patch('/api/projects/:id', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'NOT_FOUND' });

    const updates = {};
    const allowed = ['name', 'description', 'script_data', 'version', 'kill_switch', 'max_keys'];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            updates[key] = req.body[key];
        }
    }

    // Auto-hash script content when updated
    if (updates.script_data) {
        updates.version_hash = crypto.hashScript(updates.script_data);
    }

    const updated = db.updateProject(req.params.id, updates);
    res.json(updated);
});

// DELETE /api/projects/:id — Delete project + all keys
app.delete('/api/projects/:id', (req, res) => {
    db.deleteProject(req.params.id);
    res.json({ status: 'deleted' });
});

// ── Keys ─────────────────────────────────────────────

// POST /api/keys/:projectId — Create key(s)
app.post('/api/keys/:projectId', (req, res) => {
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
app.get('/api/keys/:projectId', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const keys = db.listKeys(req.params.projectId, limit, offset);
    const total = db.countKeys(req.params.projectId);
    res.json({ total, keys });
});

// PATCH /api/keys/update/:keyId — Update key
app.patch('/api/keys/update/:keyId', (req, res) => {
    const key = db.getKey(req.params.keyId);
    if (!key) return res.status(404).json({ error: 'KEY_NOT_FOUND' });

    const updated = db.updateKey(req.params.keyId, req.body);
    res.json(updated);
});

// POST /api/keys/reset-hwid/:keyId — Reset HWID
app.post('/api/keys/reset-hwid/:keyId', (req, res) => {
    const key = db.getKey(req.params.keyId);
    if (!key) return res.status(404).json({ error: 'KEY_NOT_FOUND' });

    const updated = db.resetHwid(req.params.keyId);
    res.json({ status: 'hwid_reset', key: updated });
});

// DELETE /api/keys/:keyId — Delete key
app.delete('/api/keys/:keyId', (req, res) => {
    db.deleteKey(req.params.keyId);
    res.json({ status: 'deleted' });
});

// ── Logs & Stats ─────────────────────────────────────

// GET /api/logs/:projectId — Get auth logs
app.get('/api/logs/:projectId', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const logs = db.getAuthLogs(req.params.projectId, limit);
    res.json(logs);
});

// GET /api/stats/:projectId — Get project stats
app.get('/api/stats/:projectId', (req, res) => {
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
    console.log(`  │  AntiFold Shield API — v1.0.0        │`);
    console.log(`  │  Running on http://localhost:${PORT}    │`);
    console.log(`  └──────────────────────────────────────┘\n`);
});

module.exports = app;
