const crypto = require('crypto');

// Generate a license key in format AF-XXXX-XXXX-XXXX-XXXX
function generateLicenseKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
    const segments = [];
    for (let i = 0; i < 4; i++) {
        let seg = '';
        for (let j = 0; j < 4; j++) {
            seg += chars[crypto.randomInt(chars.length)];
        }
        segments.push(seg);
    }
    return `AF-${segments.join('-')}`;
}

// Generate random hex string
function randomHex(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

// Generate session nonce (16 bytes)
function generateNonce() {
    return crypto.randomBytes(16).toString('hex');
}

// HKDF key derivation: derive AES key from master_key + hwid + nonce
function deriveKey(masterKey, hwid, nonce) {
    const ikm = Buffer.from(masterKey, 'hex');
    const salt = crypto.createHash('sha256').update(hwid).digest();
    const info = Buffer.from(nonce, 'hex');

    // HKDF-SHA256, output 32 bytes for AES-256
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    const t1 = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
    return t1; // 32 bytes = AES-256 key
}

// AES-256-GCM encrypt
function encrypt(plaintext, key) {
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Return iv + authTag + ciphertext, all hex-encoded
    return {
        iv: iv.toString('hex'),
        tag: authTag.toString('hex'),
        data: encrypted.toString('hex')
    };
}

// AES-256-GCM decrypt
function decrypt(encryptedObj, key) {
    const iv = Buffer.from(encryptedObj.iv, 'hex');
    const authTag = Buffer.from(encryptedObj.tag, 'hex');
    const encrypted = Buffer.from(encryptedObj.data, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}

// Simple obfuscation layer: XOR constants with random key, base64 encode
function obfuscateConstants(script) {
    const xorKey = crypto.randomBytes(1)[0];
    // Replace string literals with XOR-encoded versions (simplified demo)
    let result = script;
    const stringRegex = /"([^"]+)"/g;
    const replacements = [];

    let match;
    while ((match = stringRegex.exec(script)) !== null) {
        const original = match[1];
        const encoded = Buffer.from(original).map(b => b ^ xorKey).toString('base64');
        replacements.push({
            from: match[0],
            to: `__d("${encoded}",${xorKey})`
        });
    }

    // Apply replacements in reverse order to preserve indices
    for (const r of replacements.reverse()) {
        result = result.replace(r.from, r.to);
    }

    // Prepend decoder function
    const decoder = `local function __d(s,k) local r="" for i=1,#s do local b=string.byte(s,i) r=r..string.char(bit32.bxor(b,k)) end return r end\n`;
    return decoder + result;
}

// Hash script content for version checking
function hashScript(content) {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

module.exports = {
    generateLicenseKey,
    randomHex,
    generateNonce,
    deriveKey,
    encrypt,
    decrypt,
    obfuscateConstants,
    hashScript
};
