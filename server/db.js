// ═══════════════════════════════════════════════════════
//  Luaction — Postgres data layer (Supabase / Neon free tier)
//  Same export names as the old SQLite layer; every I/O
//  function is async. Pool stays tiny for free-tier limits.
// ═══════════════════════════════════════════════════════

const { Pool } = require('pg');
const { randomHex, generateLicenseKey, hashScript } = require('./crypto-utils');

let pool;

async function init() {
    if (!process.env.DATABASE_URL) {
        throw new Error('FATAL: DATABASE_URL is not set. Add your Supabase/Neon pooled connection string as env var DATABASE_URL.');
    }
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        // Supabase/Neon require TLS; local docker instances don't.
        // Append ?sslmode=disable to DATABASE_URL for non-TLS hosts.
        ssl: /[?&]sslmode=disable/.test(process.env.DATABASE_URL)
            ? false
            : { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('[db] pool error:', err.message));

    // Smoke test the connection before serving traffic.
    await pool.query('SELECT 1');

    await pool.query(`
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
            created_at  TIMESTAMPTZ DEFAULT now(),
            updated_at  TIMESTAMPTZ DEFAULT now()
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
            expires_at     TIMESTAMPTZ DEFAULT NULL,
            max_uses       INTEGER DEFAULT 0,
            use_count      INTEGER DEFAULT 0,
            last_ip        TEXT DEFAULT NULL,
            last_used      TIMESTAMPTZ DEFAULT NULL,
            checkpoint_cleared INTEGER DEFAULT 0,
            created_at     TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS auth_logs (
            id          SERIAL PRIMARY KEY,
            key_id      TEXT,
            project_id  TEXT,
            hwid        TEXT,
            ip_address  TEXT,
            status      TEXT NOT NULL,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS checkpoint_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            hwid        TEXT DEFAULT NULL,
            key_value   TEXT DEFAULT NULL,
            last_ip     TEXT DEFAULT NULL,
            current_step INTEGER DEFAULT 0,
            verified_steps INTEGER DEFAULT 0,
            checkpoint_token TEXT DEFAULT NULL,
            token_expires_at TIMESTAMPTZ DEFAULT NULL,
            created_at  TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS checkpoint_verifications (
            id          SERIAL PRIMARY KEY,
            session_id  TEXT,
            project_id  TEXT,
            step        INTEGER DEFAULT 0,
            hash        TEXT UNIQUE,
            status      TEXT NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_keys_project ON keys(project_id);
        CREATE INDEX IF NOT EXISTS idx_keys_value ON keys(key_value);
        CREATE INDEX IF NOT EXISTS idx_logs_project ON auth_logs(project_id);
        CREATE INDEX IF NOT EXISTS idx_logs_created ON auth_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_cp_session ON checkpoint_sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_cp_token ON checkpoint_sessions(checkpoint_token);
    `);

    return pool;
}

function rows(res) { return res.rows; }
function one(res) { return res.rows[0]; }

// ── Projects ─────────────────────────────────────────

async function createProject(name, description = '') {
    const id = randomHex(16);
    const apiKey = randomHex(32);
    const masterKey = randomHex(32);
    await pool.query(
        `INSERT INTO projects (id, name, description, api_key, master_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, description, apiKey, masterKey]
    );
    return getProject(id);
}

async function getProject(id) {
    return one(await pool.query('SELECT * FROM projects WHERE id = $1', [id]));
}

async function getProjectByApiKey(apiKey) {
    return one(await pool.query('SELECT * FROM projects WHERE api_key = $1', [apiKey]));
}

async function listProjects() {
    return rows(await pool.query('SELECT * FROM projects ORDER BY created_at DESC'));
}

async function updateProject(id, fields) {
    const allowed = ['name', 'description', 'script_data', 'version', 'version_hash', 'kill_switch', 'max_keys',
        'checkpoint_enabled', 'checkpoint_steps', 'linkvertise_token', 'checkpoint_cooldown_hours'];
    const updates = [];
    const values = [];

    for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            values.push(val);
            updates.push(`${key} = $${values.length}`);
        }
    }

    if (updates.length === 0) return null;

    updates.push('updated_at = now()');
    values.push(id);

    await pool.query(`UPDATE projects SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    return getProject(id);
}

async function deleteProject(id) {
    await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}

// ── Keys ─────────────────────────────────────────────

async function createKey(projectId, opts = {}) {
    const id = randomHex(16);
    const keyValue = opts.key_value || generateLicenseKey();
    await pool.query(
        `INSERT INTO keys (id, project_id, key_value, hwid, discord_id, note, expires_at, max_uses, checkpoint_cleared)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, projectId, keyValue,
            opts.hwid || null,
            opts.discord_id || null,
            opts.note || '',
            opts.expires_at || null,
            opts.max_uses || 0,
            opts.checkpoint_cleared ? 1 : 0]
    );
    return getKey(id);
}

async function createBulkKeys(projectId, count, opts = {}) {
    const keys = [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let i = 0; i < count; i++) {
            const id = randomHex(16);
            const keyValue = generateLicenseKey();
            await client.query(
                `INSERT INTO keys (id, project_id, key_value, note, expires_at, max_uses)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, projectId, keyValue, opts.note || '', opts.expires_at || null, opts.max_uses || 0]
            );
            keys.push({ id, key_value: keyValue });
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
    return keys;
}

async function getKey(id) {
    return one(await pool.query('SELECT * FROM keys WHERE id = $1', [id]));
}

async function getKeyByValue(keyValue) {
    return one(await pool.query('SELECT * FROM keys WHERE key_value = $1', [keyValue]));
}

async function listKeys(projectId, limit = 100, offset = 0) {
    return rows(await pool.query(
        'SELECT * FROM keys WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [projectId, limit, offset]
    ));
}

async function countKeys(projectId) {
    const r = one(await pool.query('SELECT COUNT(*)::int AS count FROM keys WHERE project_id = $1', [projectId]));
    return r ? r.count : 0;
}

async function updateKey(id, fields) {
    const allowed = ['hwid', 'discord_id', 'note', 'is_active', 'is_blacklisted', 'expires_at', 'max_uses', 'use_count', 'last_ip', 'last_used', 'checkpoint_cleared'];
    const updates = [];
    const values = [];

    for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            values.push(val);
            updates.push(`${key} = $${values.length}`);
        }
    }

    if (updates.length === 0) return null;
    values.push(id);

    await pool.query(`UPDATE keys SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    return getKey(id);
}

async function deleteKey(id) {
    await pool.query('DELETE FROM keys WHERE id = $1', [id]);
}

async function resetHwid(id) {
    await pool.query('UPDATE keys SET hwid = NULL WHERE id = $1', [id]);
    return getKey(id);
}

// ── Auth Logs ────────────────────────────────────────

async function logAuth(keyId, projectId, hwid, ip, status, userAgent) {
    await pool.query(
        `INSERT INTO auth_logs (key_id, project_id, hwid, ip_address, status, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [keyId, projectId, hwid, ip, status, userAgent || '']
    );
}

async function getAuthLogs(projectId, limit = 50) {
    return rows(await pool.query(
        `SELECT al.*, k.key_value
         FROM auth_logs al
         LEFT JOIN keys k ON al.key_id = k.id
         WHERE al.project_id = $1
         ORDER BY al.created_at DESC
         LIMIT $2`,
        [projectId, limit]
    ));
}

// ── Stats ────────────────────────────────────────────

async function getProjectStats(projectId) {
    const q = (text, params) => pool.query(text, params).then(r => (r.rows[0] ? Number(r.rows[0].c) : 0));
    const totalKeys = await q('SELECT COUNT(*) AS c FROM keys WHERE project_id = $1', [projectId]);
    const activeKeys = await q('SELECT COUNT(*) AS c FROM keys WHERE project_id = $1 AND is_active = 1 AND is_blacklisted = 0', [projectId]);
    const boundKeys = await q('SELECT COUNT(*) AS c FROM keys WHERE project_id = $1 AND hwid IS NOT NULL', [projectId]);
    const totalAuths = await q('SELECT COUNT(*) AS c FROM auth_logs WHERE project_id = $1', [projectId]);
    const successAuths = await q("SELECT COUNT(*) AS c FROM auth_logs WHERE project_id = $1 AND status = 'SUCCESS'", [projectId]);
    const recentAuths = await q(
        `SELECT COUNT(*) AS c FROM auth_logs
         WHERE project_id = $1 AND created_at > now() - interval '24 hours'`,
        [projectId]
    );

    return {
        total_keys: totalKeys,
        active_keys: activeKeys,
        bound_keys: boundKeys,
        total_auths: totalAuths,
        success_auths: successAuths,
        failed_auths: totalAuths - successAuths,
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

async function createCheckpointSession(projectId, { hwid, key_value, ip }) {
    const id = randomHex(16);
    await pool.query(
        `INSERT INTO checkpoint_sessions (id, project_id, hwid, key_value, last_ip, current_step, verified_steps)
         VALUES ($1, $2, $3, $4, $5, 0, 0)`,
        [id, projectId, hwid || null, key_value || null, ip || null]
    );
    return getCheckpointSession(id);
}

async function getCheckpointSession(id) {
    return one(await pool.query('SELECT * FROM checkpoint_sessions WHERE id = $1', [id]));
}

// Latest still-incomplete session for this project+hwid (30 min window).
async function findPendingSession(projectId, hwid) {
    if (!hwid) return null;
    return one(await pool.query(
        `SELECT * FROM checkpoint_sessions
         WHERE project_id = $1 AND hwid = $2
           AND checkpoint_token IS NULL
           AND created_at > now() - interval '30 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, hwid]
    ));
}

// Refresh key/IP on a resumed session.
async function touchCheckpointSession(id, { key_value, ip }) {
    const s = await getCheckpointSession(id);
    if (!s) return s;
    await pool.query(
        `UPDATE checkpoint_sessions
         SET key_value = COALESCE($1, key_value),
             last_ip = COALESCE($2, last_ip)
         WHERE id = $3`,
        [key_value || null, ip || null, id]
    );
    return getCheckpointSession(id);
}

// Recent verification attempts for admin debugging (newest first).
async function getCheckpointAttempts(projectId, limit = 50) {
    return rows(await pool.query(
        `SELECT v.*, s.hwid AS session_hwid, s.verified_steps
         FROM checkpoint_verifications v
         LEFT JOIN checkpoint_sessions s ON s.id = v.session_id
         WHERE v.project_id = $1
         ORDER BY v.created_at DESC
         LIMIT $2`,
        [projectId, limit]
    ));
}

async function getSessionByToken(token) {
    if (!token) return null;
    return one(await pool.query('SELECT * FROM checkpoint_sessions WHERE checkpoint_token = $1', [token]));
}

// Valid (non-expired) checkpoint token for this project + hwid/key combo.
async function getValidCheckpoint(projectId, { hwid, key_value, checkpoint_token }) {
    if (checkpoint_token) {
        const s = await getSessionByToken(checkpoint_token);
        if (!s || s.project_id !== projectId) return null;
        if (!s.token_expires_at || new Date(s.token_expires_at) < new Date()) return null;
        if (hwid && s.hwid && s.hwid !== hwid) return null;
        if (key_value && s.key_value && s.key_value !== key_value) return null;
        return s;
    }
    let row = null;
    if (key_value) {
        row = one(await pool.query(
            `SELECT * FROM checkpoint_sessions
             WHERE project_id = $1 AND key_value = $2
               AND checkpoint_token IS NOT NULL
               AND token_expires_at > now()
             ORDER BY token_expires_at DESC LIMIT 1`,
            [projectId, key_value]
        ));
        if (row && hwid && row.hwid && row.hwid !== hwid) return null;
        if (row) return row;
    }
    if (hwid) {
        row = one(await pool.query(
            `SELECT * FROM checkpoint_sessions
             WHERE project_id = $1 AND hwid = $2
               AND checkpoint_token IS NOT NULL
               AND token_expires_at > now()
             ORDER BY token_expires_at DESC LIMIT 1`,
            [projectId, hwid]
        ));
        if (row) return row;
    }
    return null;
}

async function markStepVerified(sessionId, step, hash, cooldownHours) {
    const s = await getCheckpointSession(sessionId);
    if (!s) return null;
    const project = await getProject(s.project_id);
    const steps = parseSteps(project);
    const cooldown = Number(project?.checkpoint_cooldown_hours ?? cooldownHours ?? 24) || 24;

    await pool.query(
        `INSERT INTO checkpoint_verifications (session_id, project_id, step, hash, status)
         VALUES ($1, $2, $3, $4, 'VERIFIED')
         ON CONFLICT (hash) DO NOTHING`,
        [sessionId, s.project_id, step, hash]
    );

    const nextVerified = Math.max(s.verified_steps, step + 1);
    const done = nextVerified >= steps.length;

    let token = s.checkpoint_token;
    let expires = s.token_expires_at;
    if (done) {
        token = randomHex(32);
        expires = new Date(Date.now() + cooldown * 3600 * 1000).toISOString();
    }

    await pool.query(
        `UPDATE checkpoint_sessions
         SET verified_steps = $1, current_step = $2, checkpoint_token = $3, token_expires_at = $4
         WHERE id = $5`,
        [nextVerified, nextVerified, token, expires, sessionId]
    );
    return { session: await getCheckpointSession(sessionId), done };
}

async function logCheckpointAttempt(sessionId, projectId, step, hash, status) {
    try {
        await pool.query(
            `INSERT INTO checkpoint_verifications (session_id, project_id, step, hash, status)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (hash) DO NOTHING`,
            [sessionId, projectId, step, hash, status]
        );
    } catch { /* ignore */ }
}

// Attribute a verified Linkvertise hash to the latest waiting session.
async function claimCheckpointByIP(projectId, step, hash, ip) {
    const seen = hash
        ? one(await pool.query('SELECT id FROM checkpoint_verifications WHERE hash = $1', [hash]))
        : null;
    if (seen) return null;

    let s = one(await pool.query(
        `SELECT * FROM checkpoint_sessions
         WHERE project_id = $1 AND verified_steps = $2
           AND created_at > now() - interval '30 minutes'
           AND (last_ip = $3 OR last_ip IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, step, ip]
    ));

    if (!s) {
        // Localhost/dev fallback: IPs often differ (::1 vs 127.0.0.1)
        s = one(await pool.query(
            `SELECT * FROM checkpoint_sessions
             WHERE project_id = $1 AND verified_steps = $2
               AND created_at > now() - interval '5 minutes'
             ORDER BY created_at DESC LIMIT 1`,
            [projectId, step]
        ));
    }
    if (!s) return null;

    const project = await getProject(projectId);
    const { session } = await markStepVerified(s.id, step, hash, project?.checkpoint_cooldown_hours);
    return session;
}

module.exports = {
    init,
    createProject, getProject, getProjectByApiKey, listProjects, updateProject, deleteProject,
    createKey, createBulkKeys, getKey, getKeyByValue, listKeys, countKeys, updateKey, deleteKey, resetHwid,
    logAuth, getAuthLogs,
    getProjectStats,
    parseSteps, isCheckpointRequired, createCheckpointSession, getCheckpointSession,
    findPendingSession, touchCheckpointSession, getCheckpointAttempts,
    getSessionByToken, getValidCheckpoint, markStepVerified, logCheckpointAttempt,
    claimCheckpointByIP
};
