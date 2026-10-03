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
    `);

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
    const allowed = ['name', 'description', 'script_data', 'version', 'version_hash', 'kill_switch', 'max_keys'];
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
        INSERT INTO keys (id, project_id, key_value, hwid, discord_id, note, expires_at, max_uses)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        id, projectId, keyValue,
        opts.hwid || null,
        opts.discord_id || null,
        opts.note || '',
        opts.expires_at || null,
        opts.max_uses || 0
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
    const allowed = ['hwid', 'discord_id', 'note', 'is_active', 'is_blacklisted', 'expires_at', 'max_uses', 'use_count', 'last_ip', 'last_used'];
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

module.exports = {
    init,
    createProject, getProject, getProjectByApiKey, listProjects, updateProject, deleteProject,
    createKey, createBulkKeys, getKey, getKeyByValue, listKeys, countKeys, updateKey, deleteKey, resetHwid,
    logAuth, getAuthLogs,
    getProjectStats
};

