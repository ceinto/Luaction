// ═══════════════════════════════════════════════════════
//  Luaction — Challenge-response handshake (nonce2/auth7)
//  Mirrors the in-game client's GetExpected exactly.
//  All values stay < 2^53, so doubles are bit-exact.
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');

const MOD = 900000000000;
const BUCKET = 15;              // must match client Bucket
const NONCE_TTL_MS = 90 * 1000; // covers bucket rollover + latency
const TICKET_TTL_MS = 60 * 1000; // completed-handshake redemption window

function mod(v) {
    return ((v % MOD) + MOD) % MOD;
}

// Exact port of the client's GetExpected(rngSeed, nonce, timeBucket).
function getExpected(rngSeed, nonce, timeBucket) {
    let x = mod(Math.floor(rngSeed));
    const n = mod(Math.floor(nonce));
    const t = mod(Math.floor(timeBucket));

    x = mod(x * 191 + n * 163 + t * 97 + 59);

    let digits = x;
    while (digits > 0) {
        const digit = digits % 10;
        for (let k = 0; k < 4; k++) { // 2 x 2 nested iterations
            if (digit % 2 === 0) x = mod(x * 73 + n * 29 + t * 11 + digit + 11);
            else x = mod(x * 97 + n * 17 + t * 7 + digit + 37);

            if (mod(x + t) % 3 === 0) x = mod(x + n * 113 + t * 17);
            else if (mod(x + t) % 3 === 1) x = mod(x * 31 + n * 17 + t * 19 + 73);
            else x = mod(x * 43 + n * 29 + t * 13 + 131);

            if (digit % 5 === 0) x = mod(x * 41 + t * 23 + digit + 12345);
            else x = mod(x * 53 + n * 19 + t * 31 + digit + 6789);

            if (mod(x + t) % 7 < 3) x = mod(x * 19 + n * 23 + t * 29 + 123);
            else x = mod(x * 37 + n * 13 + t * 41 + 4567);
        }
        digits = Math.floor(digits / 10);
    }
    return Math.floor(x);
}

function currentBucket() {
    return Math.floor(Date.now() / 1000 / BUCKET);
}

// ── Pending challenges: nonce → { rngSeed, bucket, keyId, projectId, ip, expiresAt } ──
const pending = new Map();

function sweep() {
    const now = Date.now();
    for (const [nonce, c] of pending) {
        if (c.expiresAt <= now) pending.delete(nonce);
    }
    if (pending.size > 5000) {
        // Overload guard: drop oldest
        const oldest = [...pending.keys()].slice(0, pending.size - 5000);
        for (const k of oldest) pending.delete(k);
    }
}

function mintNonce(rngSeed, keyRecord, ip) {
    sweep();
    const nonce = crypto.randomInt(0, MOD);
    pending.set(String(nonce), {
        rngSeed: Math.floor(rngSeed),
        bucket: currentBucket(),
        keyId: keyRecord.id,
        projectId: keyRecord.project_id,
        keyValue: keyRecord.key_value,
        ip,
        expiresAt: Date.now() + NONCE_TTL_MS
    });
    return nonce;
}

// Match a client's auth7 response. Returns { reply, challenge } or null.
// Tries stored bucket ±1 to tolerate clock skew at bucket edges.
function verifyResponse(response, ip) {
    const want = Math.floor(Number(response));
    if (!Number.isFinite(want)) return null;
    sweep();

    for (const [nonceStr, c] of pending) {
        if (c.expiresAt <= Date.now()) continue;
        if (c.ip && ip && c.ip !== ip) continue;
        const nonce = Number(nonceStr);
        for (const b of [c.bucket - 1, c.bucket, c.bucket + 1]) {
            if (getExpected(c.rngSeed, nonce, b) === want) {
                let nonceVar = nonce + c.rngSeed - 100000000000;
                if (nonceVar < 0) nonceVar = nonceVar * -1;
                const reply = getExpected(want, nonceVar, b);
                pending.delete(nonceStr); // single-use
                return { reply, challenge: c };
            }
        }
    }
    return null;
}

// ── Completed handshakes awaiting script fetch ─────────
// reply → { keyId, keyValue, projectId, ip, expiresAt }.
// Single-use: consumed by POST /api/fetch. The reply doubles
// as the payload keystream seed (never transported separately).
const completed = new Map();

function completeChallenge(reply, challenge) {
    sweepCompleted();
    completed.set(String(reply), {
        keyId: challenge.keyId,
        keyValue: challenge.keyValue,
        projectId: challenge.projectId,
        ip: challenge.ip,
        expiresAt: Date.now() + TICKET_TTL_MS
    });
    if (completed.size > 5000) {
        const oldest = [...completed.keys()].slice(0, completed.size - 5000);
        for (const k of oldest) completed.delete(k);
    }
}

function sweepCompleted() {
    const now = Date.now();
    for (const [reply, c] of completed) {
        if (c.expiresAt <= now) completed.delete(reply);
    }
}

// Returns the record and consumes it, or null.
function consumeCompleted(reply, keyValue) {
    sweepCompleted();
    const rec = completed.get(String(reply));
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) { completed.delete(String(reply)); return null; }
    if (rec.keyValue !== keyValue) return null;
    completed.delete(String(reply));
    return rec;
}

module.exports = {
    MOD,
    BUCKET,
    NONCE_TTL_MS,
    TICKET_TTL_MS,
    getExpected,
    currentBucket,
    mintNonce,
    verifyResponse,
    completeChallenge,
    consumeCompleted,
    // exposed for tests
    _pending: pending,
    _completed: completed
};
