const Database = require('better-sqlite3');
const path = require('path');
const { randomHex, generateLicenseKey, hashScript } = require('./crypto-utils');

const DB_PATH = path.join(__dirname, 'luaction.db');
let db;

function init() {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT DEFAULT '',
            api_key     TEXT NOT NULL UNIQUE,
            master_key  TEXT NOT NULL,
            script_data TEXT DEFAULT '',
            version     TEXT DEFAULT '1.0.0',
            version_hash TEXT DEFAULT '',
            kill_switch INTEGER DEFAULT 0,
            max_keys    INTEGER DEFAULT 100,
            checkpoint_enabled INTEGER DEFAULT 0,
            checkpoint_steps TEXT DEFAULT '[]',
            linkvertise_token TEXT DEFAULT '',
            checkpoint_cooldown_hours INTEGER DEFAULT 24,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS keys (
            id             TEXT PRIMARY KEY,
            project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            key_value      TEXT NOT NULL UNIQUE,
            hwid           TEXT DEFAULT NULL,
            discord_id     TEXT DEFAULT NULL,
            note           TEXT DEFAULT '',
            is_active      INTEGER DEFAULT 1,
            is_blacklisted INTEGER DEFAULT 0,
            expires_at     DATETIME DEFAULT NULL,
            max_uses       INTEGER DEFAULT 0,
            use_count      INTEGER DEFAULT 0,
            last_ip        TEXT DEFAULT NULL,
            last_used      DATETIME DEFAULT NULL,
            checkpoint_cleared INTEGER DEFAULT 0,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS auth_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            key_id      TEXT,
            project_id  TEXT,
            hwid        TEXT,
            ip_address  TEXT,
            status      TEXT NOT NULL,
            user_agent  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_keys_project ON keys(project_id);
        CREATE INDEX IF NOT EXISTS idx_keys_value ON keys(key_value);
        CREATE INDEX IF NOT EXISTS idx_logs_project ON auth_logs(project_id);
        CREATE INDEX IF NOT EXISTS idx_logs_created ON auth_logs(created_at);

        CREATE TABLE IF NOT EXISTS checkpoint_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            hwid        TEXT DEFAULT NULL,
            key_value   TEXT DEFAULT NULL,
            last_ip     TEXT DEFAULT NULL,
            current_step INTEGER DEFAULT 0,
            verified_steps INTEGER DEFAULT 0,
            checkpoint_token TEXT DEFAULT NULL,
            token_expires_at DATETIME DEFAULT NULL,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS checkpoint_verifications (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT,
            project_id  TEXT,
            step        INTEGER DEFAULT 0,
            hash        TEXT,
            status      TEXT NOT NULL,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_cp_session ON checkpoint_sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_cp_token ON checkpoint_sessions(checkpoint_token);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_verify_hash ON checkpoint_verifications(hash);
    `);

    // ── Migrate existing DBs (added after initial release) ──
    try {
        const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name);
        const addCol = (name, def) => {
            if (!cols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
        };
        addCol('checkpoint_enabled', 'INTEGER DEFAULT 0');
        addCol('checkpoint_steps', "TEXT DEFAULT '[]'");
        addCol('linkvertise_token', "TEXT DEFAULT ''");
        addCol('checkpoint_cooldown_hours', 'INTEGER DEFAULT 24');
        const cpCols = db.prepare(`PRAGMA table_info(checkpoint_sessions)`).all().map(c => c.name);
        if (!cpCols.includes('last_ip')) db.exec(`ALTER TABLE checkpoint_sessions ADD COLUMN last_ip TEXT DEFAULT NULL`);
        const keyCols = db.prepare(`PRAGMA table_info(keys)`).all().map(c => c.name);
        if (!keyCols.includes('checkpoint_cleared')) db.exec(`ALTER TABLE keys ADD COLUMN checkpoint_cleared INTEGER DEFAULT 0`);
    } catch { /* fresh DB already has columns */ }

    return db;
}

// ── Projects ─────────────────────────────────────────

function createProject(name, description = '') {
    const id = randomHex(16);
    const apiKey = randomHex(32);
    const masterKey = randomHex(32);

    const stmt = db.prepare(`
        INSERT INTO projects (id, name, description, api_key, master_key)
        VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, description, apiKey, masterKey);
    return getProject(id);
}

function getProject(id) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function getProjectByApiKey(apiKey) {
    return db.prepare('SELECT * FROM projects WHERE api_key = ?').get(apiKey);
}

function listProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

function updateProject(id, fields) {
    const allowed = ['name', 'description', 'script_data', 'version', 'version_hash', 'kill_switch', 'max_keys',
        'checkpoint_enabled', 'checkpoint_steps', 'linkvertise_token', 'checkpoint_cooldown_hours'];
    const updates = [];
    const values = [];

    for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            updates.push(`${key} = ?`);
            values.push(val);
        }
    }

    if (updates.length === 0) return null;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getProject(id);
}

function deleteProject(id) {
    return db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ── Keys ─────────────────────────────────────────────

function createKey(projectId, opts = {}) {
    const id = randomHex(16);
    const keyValue = opts.key_value || generateLicenseKey();

    const stmt = db.prepare(`
        INSERT INTO keys (id, project_id, key_value, hwid, discord_id, note, expires_at, max_uses, checkpoint_cleared)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        id, projectId, keyValue,
        opts.hwid || null,
        opts.discord_id || null,
        opts.note || '',
        opts.expires_at || null,
        opts.max_uses || 0,
        opts.checkpoint_cleared ? 1 : 0
    );
    return getKey(id);
}

function createBulkKeys(projectId, count, opts = {}) {
    const keys = [];
    const insert = db.prepare(`
        INSERT INTO keys (id, project_id, key_value, note, expires_at, max_uses)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const id = randomHex(16);
            const keyValue = generateLicenseKey();
            insert.run(id, projectId, keyValue, opts.note || '', opts.expires_at || null, opts.max_uses || 0);
            keys.push({ id, key_value: keyValue });
        }
    });
    tx();
    return keys;
}

function getKey(id) {
    return db.prepare('SELECT * FROM keys WHERE id = ?').get(id);
}

function getKeyByValue(keyValue) {
    return db.prepare('SELECT * FROM keys WHERE key_value = ?').get(keyValue);
}

function listKeys(projectId, limit = 100, offset = 0) {
    return db.prepare('SELECT * FROM keys WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(projectId, limit, offset);
}

function countKeys(projectId) {
    return db.prepare('SELECT COUNT(*) as count FROM keys WHERE project_id = ?').get(projectId).count;
}

function updateKey(id, fields) {
    const allowed = ['hwid', 'discord_id', 'note', 'is_active', 'is_blacklisted', 'expires_at', 'max_uses', 'use_count', 'last_ip', 'last_used', 'checkpoint_cleared'];
    const updates = [];
    const values = [];

    for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            updates.push(`${key} = ?`);
            values.push(val);
        }
    }

    if (updates.length === 0) return null;
    values.push(id);

    db.prepare(`UPDATE keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getKey(id);
}

function deleteKey(id) {
    return db.prepare('DELETE FROM keys WHERE id = ?').run(id);
}

function resetHwid(id) {
    db.prepare('UPDATE keys SET hwid = NULL WHERE id = ?').run(id);
    return getKey(id);
}

// ── Auth Logs ────────────────────────────────────────

function logAuth(keyId, projectId, hwid, ip, status, userAgent) {
    db.prepare(`
        INSERT INTO auth_logs (key_id, project_id, hwid, ip_address, status, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(keyId, projectId, hwid, ip, status, userAgent || '');
}

function getAuthLogs(projectId, limit = 50) {
    return db.prepare(`
        SELECT al.*, k.key_value 
        FROM auth_logs al 
        LEFT JOIN keys k ON al.key_id = k.id 
        WHERE al.project_id = ? 
        ORDER BY al.created_at DESC 
        LIMIT ?
    `).all(projectId, limit);
}

// ── Stats ────────────────────────────────────────────

function getProjectStats(projectId) {
    const totalKeys = db.prepare('SELECT COUNT(*) as c FROM keys WHERE project_id = ?').get(projectId).c;
    const activeKeys = db.prepare('SELECT COUNT(*) as c FROM keys WHERE project_id = ? AND is_active = 1 AND is_blacklisted = 0').get(projectId).c;
    const boundKeys = db.prepare('SELECT COUNT(*) as c FROM keys WHERE project_id = ? AND hwid IS NOT NULL').get(projectId).c;

    const totalAuths = db.prepare('SELECT COUNT(*) as c FROM auth_logs WHERE project_id = ?').get(projectId).c;
    const successAuths = db.prepare("SELECT COUNT(*) as c FROM auth_logs WHERE project_id = ? AND status = 'SUCCESS'").get(projectId).c;
    const failedAuths = totalAuths - successAuths;

    const recentAuths = db.prepare(`
        SELECT COUNT(*) as c FROM auth_logs 
        WHERE project_id = ? AND created_at > datetime('now', '-24 hours')
    `).get(projectId).c;

    return {
        total_keys: totalKeys,
        active_keys: activeKeys,
        bound_keys: boundKeys,
        total_auths: totalAuths,
        success_auths: successAuths,
        failed_auths: failedAuths,
        auths_24h: recentAuths
    };
}

// ── Checkpoints (Linkvertise-gated) ────────────────────

function parseSteps(project) {
    if (!project) return [];
    try {
        const v = typeof project.checkpoint_steps === 'string'
            ? JSON.parse(project.checkpoint_steps)
            : project.checkpoint_steps;
        return Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()) : [];
    } catch { return []; }
}

function isCheckpointRequired(project) {
    if (!project || !project.checkpoint_enabled) return false;
    return parseSteps(project).length > 0;
}

function createCheckpointSession(projectId, { hwid, key_value, ip }) {
    const id = randomHex(16);
    db.prepare(`
        INSERT INTO checkpoint_sessions (id, project_id, hwid, key_value, last_ip, current_step, verified_steps)
        VALUES (?, ?, ?, ?, ?, 0, 0)
    `).run(id, projectId, hwid || null, key_value || null, ip || null);
    return getCheckpointSession(id);
}

function getCheckpointSession(id) {
    return db.prepare('SELECT * FROM checkpoint_sessions WHERE id = ?').get(id);
}

function getSessionByToken(token) {
    if (!token) return null;
    return db.prepare('SELECT * FROM checkpoint_sessions WHERE checkpoint_token = ?').get(token);
}

// Valid (non-expired) checkpoint token for this project + hwid/key combo.
// Used by /api/auth and /api/keys/claim.
function getValidCheckpoint(projectId, { hwid, key_value, checkpoint_token }) {
    if (checkpoint_token) {
        const s = getSessionByToken(checkpoint_token);
        if (!s || s.project_id !== projectId) return null;
        if (!s.token_expires_at || new Date(s.token_expires_at) < new Date()) return null;
        if (hwid && s.hwid && s.hwid !== hwid) return null;
        if (key_value && s.key_value && s.key_value !== key_value) return null;
        return s;
    }
    // Fallback: any unexpired token bound to same hwid (+key if given)
    let row = null;
    if (key_value) {
        row = db.prepare(`
            SELECT * FROM checkpoint_sessions
            WHERE project_id = ? AND key_value = ?
              AND checkpoint_token IS NOT NULL
              AND token_expires_at > datetime('now')
            ORDER BY token_expires_at DESC LIMIT 1
        `).get(projectId, key_value);
        if (row && hwid && row.hwid && row.hwid !== hwid) return null;
        if (row) return row;
    }
    if (hwid) {
        row = db.prepare(`
            SELECT * FROM checkpoint_sessions
            WHERE project_id = ? AND hwid = ?
              AND checkpoint_token IS NOT NULL
              AND token_expires_at > datetime('now')
            ORDER BY token_expires_at DESC LIMIT 1
        `).get(projectId, hwid);
        if (row) return row;
    }
    return null;
}

function markStepVerified(sessionId, step, hash, cooldownHours) {
    const s = getCheckpointSession(sessionId);
    if (!s) return null;
    const project = getProject(s.project_id);
    const steps = parseSteps(project);
    const cooldown = Number(project?.checkpoint_cooldown_hours ?? cooldownHours ?? 24) || 24;

    db.prepare(`
        INSERT OR IGNORE INTO checkpoint_verifications (session_id, project_id, step, hash, status)
        VALUES (?, ?, ?, ?, 'VERIFIED')
    `).run(sessionId, s.project_id, step, hash);

    const nextVerified = Math.max(s.verified_steps, step + 1);
    const done = nextVerified >= steps.length;

    let token = s.checkpoint_token;
    let expires = s.token_expires_at;
    if (done) {
        token = randomHex(32);
        expires = new Date(Date.now() + cooldown * 3600 * 1000).toISOString();
    }

    db.prepare(`
        UPDATE checkpoint_sessions
        SET verified_steps = ?, current_step = ?, checkpoint_token = ?, token_expires_at = ?
        WHERE id = ?
    `).run(nextVerified, nextVerified, token, expires, sessionId);
    return { session: getCheckpointSession(sessionId), done };
}

function logCheckpointAttempt(sessionId, projectId, step, hash, status) {
    try {
        db.prepare(`
            INSERT OR IGNORE INTO checkpoint_verifications (session_id, project_id, step, hash, status)
            VALUES (?, ?, ?, ?, ?)
        `).run(sessionId, projectId, step, hash, status);
    } catch { /* ignore */ }
}

// Attribute a verified Linkvertise hash to the latest waiting session
// (static Target URL mode — Linkvertise can't carry the session id).
// Returns the updated session, or null if nothing is waiting.
function claimCheckpointByIP(projectId, step, hash, ip) {
    // Reject hash replays (Linkvertise hashes are single-use)
    const seen = hash ? db.prepare('SELECT id FROM checkpoint_verifications WHERE hash = ?').get(hash) : null;
    if (seen) return null;

    let s = db.prepare(`
        SELECT * FROM checkpoint_sessions
        WHERE project_id = ? AND verified_steps = ?
          AND datetime(created_at) > datetime('now', '-30 minutes')
          AND (last_ip = ? OR last_ip IS NULL)
        ORDER BY datetime(created_at) DESC LIMIT 1
    `).get(projectId, step, ip);

    if (!s) {
        // Localhost/dev fallback: IPs often differ (::1 vs 127.0.0.1)
        s = db.prepare(`
            SELECT * FROM checkpoint_sessions
            WHERE project_id = ? AND verified_steps = ?
              AND datetime(created_at) > datetime('now', '-5 minutes')
            ORDER BY datetime(created_at) DESC LIMIT 1
        `).get(projectId, step);
    }
    if (!s) return null;

    const project = getProject(projectId);
    const { session } = markStepVerified(s.id, step, hash, project?.checkpoint_cooldown_hours);
    return session;
}

module.exports = {
    init,
    createProject, getProject, getProjectByApiKey, listProjects, updateProject, deleteProject,
    createKey, createBulkKeys, getKey, getKeyByValue, listKeys, countKeys, updateKey, deleteKey, resetHwid,
    logAuth, getAuthLogs,
    getProjectStats,
    parseSteps, isCheckpointRequired, createCheckpointSession, getCheckpointSession,
    getSessionByToken, getValidCheckpoint, markStepVerified, logCheckpointAttempt,
    claimCheckpointByIP
};

