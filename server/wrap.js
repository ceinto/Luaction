// ═══════════════════════════════════════════════════════
//  Luaction — Polymorphic wrapper engine (Luarmor-style)
//  Every delivery is unique: randomized names, junk, per-
//  delivery salt + string encryption. Payload stream keyed
//  by split 16/16 fold of (handshake reply, salt) — neither
//  closure alone yields the seed, nothing static crosses
//  deliveries. Live reply always re-verified client-side;
//  a rotating second factor (salted sentinel / branchless /
//  blob checksum) denies single-pattern hooks.
//  Tampered bytes decrypt to garbage -> loadstring dies.
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');

const B64ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LUA_KW = new Set(('and break do else elseif end false for function if in local nil not or ' +
    'repeat return then true until while').split(' '));

// ── Small deterministic primitives (mirrored in chunk) ──

function bxor32(a, b) { return (a ^ b) >>> 0; }

function fnv1a(str) {
    // NOTE: plain double multiply, NOT Math.imul — the in-chunk twin
    // multiplies in doubles (product overflows 2^53 and rounds).
    // Both sides are IEEE-754, so results are identical.
    let h = 0x811c9dc5;
    const buf = Buffer.from(str, 'utf8');
    for (const byte of buf) {
        h = bxor32(h, byte);
        h = (h * 16777619) % 4294967296;
    }
    return h >>> 0;
}

// LCG stream — byte-identical twin lives inside the chunk.
function lcgStream(seed, len) {
    let s = seed % 4294967296;
    if (s === 0) s = 1;
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
        s = (s * 1664525 + 1013904223) % 4294967296;
        out[i] = Math.floor(s / 65536) % 256;
    }
    return { out, state: s };
}

// Split 16/16 key fold — byte-identical twins (XA/XB) live in the chunk.
// seed = fold(reply, salt): no single closure yields the full key, and
// nothing static crosses deliveries. All operands non-negative, all
// intermediate values < 2^53, so doubles are bit-exact on both sides.
function foldSeed(r, s) {
    r = Math.floor(Number(r)); s = Math.floor(Number(s));
    const M32 = 4294967296;
    const rn = ((r % M32) + M32) % M32, sn = ((s % M32) + M32) % M32;
    const lo = ((rn % 65536) ^ (sn % 65536)) >>> 0;
    const hi = ((Math.floor(rn / 65536) % 65536) ^ (Math.floor(sn / 65536) % 65536)) >>> 0;
    return (hi * 65536 + lo) >>> 0;
}

function xorCrypt(buf, seed) {
    // Additive stream (NOT xor): mirrors Lua `(b - ks) % 256`,
    // which needs no bit32/bitop support on any Lua version.
    const { out } = lcgStream(seed, buf.length);
    const res = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) res[i] = (buf[i] + out[i]) % 256;
    return res;
}

// ── Polymorphism helpers ───────────────────────────────

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Fixed length (6): no name can ever be a substring of another,
// so sequential token substitution is always safe.
function randName(used) {
    let n;
    do {
        n = '_';
        for (let i = 0; i < 5; i++) n += NAME_CHARS[crypto.randomInt(NAME_CHARS.length)];
    } while (used.has(n) || LUA_KW.has(n));
    used.add(n);
    return n;
}

function randInt(a, b) { return a + crypto.randomInt(b - a + 1); }

// Dead arithmetic block — terminates, touches only dead locals.
function junkBlock(used) {
    const a = randName(used), b = randName(used), n = randInt(2, 5);
    const c1 = randInt(11, 989), c2 = randInt(11, 989), c3 = randInt(2, 9);
    const ops = [
        `local ${a}=${c1};for ${b}=1,${n} do ${a}=(${a}*${c3}+${b}*${c2})%${randInt(100003, 999983)} end`,
        `local ${a}=${c1};if (${a}*${c3}+${c2})%${randInt(3, 97)}~=${a} then ${a}=${a}+${c2} end`,
        `local ${a}={};for ${b}=1,${n} do ${a}[${b}]=(${b}*${c1}+${c2})%${c3} end`,
    ];
    return ops[crypto.randomInt(ops.length)];
}

// Per-delivery 1-byte XOR + base64 for wrapper string literals.
function encConst(str, used) {
    const k = randInt(1, 250);
    const buf = Buffer.from(str, 'utf8');
    for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] + k) % 256;
    return { b64: buf.toString('base64'), k };
}

// ── Chunk template ─────────────────────────────────────
// Tokens @N are replaced with per-delivery random names.
// Arg order: (reply, key, hwid, apiBase), passed via chunk varargs:
//   loadstring(chunk)(reply, key, hwid, apiBase)
// CONTRACT: apiBase is the host base WITHOUT a trailing "/api"
// (e.g. https://host). The first line normalizes anyway, so callers
// passing ".../api" still work — the doubling class is dead.
// NOTE: same-line statements are ';'-separated (valid 5.1 + Luau);
// no line may END with a lone ';' (empty statement, illegal in 5.1).
function template(n) {
    return `
local ${n.R},${n.K},${n.H},${n.A}=...
if ${n.A}:sub(-4)=="/api" then ${n.A}=${n.A}:sub(1,-5) end
@JUNK1
local function ${n.B}(s) local m={};local abc=${n.ABC};for i=1,#abc do m[abc:sub(i,i)]=i-1 end;local o={};local pad=0;if s:sub(-2)=='==' then pad=2 elseif s:sub(-1)=='=' then pad=1 end;local L=#s;for i=1,L,4 do local a=(m[s:sub(i,i)] or 0)*262144+(m[s:sub(i+1,i+1)] or 0)*4096+(m[s:sub(i+2,i+2)] or 0)*64+(m[s:sub(i+3,i+3)] or 0);o[#o+1]=math.floor(a/65536)%256;o[#o+1]=math.floor(a/256)%256;o[#o+1]=a%256 end;for i=1,pad do o[#o]=nil end;return o end
@JUNK2
local function ${n.D}(s,k) local b=${n.B}(s);local r={};for i=1,#b do r[i]=string.char((b[i]-k)%256) end;return table.concat(r) end
@JUNK3
local function ${n.X}(s,s2) local b=${n.B}(s);local q=s2%4294967296;if q==0 then q=1 end;local r={};for i=1,#b do q=(q*1664525+1013904223)%4294967296;b[i]=(b[i]-math.floor(q/65536)%256)%256;r[i]=string.char((b[i]+256)%256) end;return table.concat(r) end
@JUNK4
local function ${n.M}(v) local o=900000000000;return ((v%o)+o)%o end
local function ${n.G}(g1,g2,g3) local x=${n.M}(g1);local nn=${n.M}(g2);local t=${n.M}(g3);x=${n.M}(x*191+nn*163+t*97+59);local dg=x;while dg>0 do local dt=dg%10;for kk=1,4 do if dt%2==0 then x=${n.M}(x*73+nn*29+t*11+dt+11) else x=${n.M}(x*97+nn*17+t*7+dt+37) end;if ${n.M}(x+t)%3==0 then x=${n.M}(x+nn*113+t*17) elseif ${n.M}(x+t)%3==1 then x=${n.M}(x*31+nn*17+t*19+73) else x=${n.M}(x*43+nn*29+t*13+131) end;if dt%5==0 then x=${n.M}(x*41+t*23+dt+12345) else x=${n.M}(x*53+nn*19+t*31+dt+6789) end;if ${n.M}(x+t)%7<3 then x=${n.M}(x*19+nn*23+t*29+123) else x=${n.M}(x*37+nn*13+t*41+4567) end end;dg=math.floor(dg/10) end;return math.floor(x) end
@JUNK5
local function ${n.F}(s) local h=2166136261;local b={s:byte(1,-1)};for i=1,#b do local v=h;local w=b[i];local r=0;local p2=1;for j=1,32 do local bv=v%2;v=math.floor(v/2);local bw=w%2;w=math.floor(w/2);if bv~=bw then r=r+p2 end;p2=p2*2 end;h=r%4294967296;h=(h*16777619)%4294967296 end;return h end
local function ${n.XA}(a,b) a=((a%4294967296)+4294967296)%4294967296;b=((b%4294967296)+4294967296)%4294967296;local x=a%65536;local y=b%65536;local r=0;local p=1;for j=1,16 do local av=x%2;x=math.floor(x/2);local bv=y%2;y=math.floor(y/2);if av~=bv then r=r+p end;p=p*2 end;return r end
local function ${n.XB}(a,b) a=((a%4294967296)+4294967296)%4294967296;b=((b%4294967296)+4294967296)%4294967296;local x=math.floor(a/65536)%65536;local y=math.floor(b/65536)%65536;local r=0;local p=1;for j=1,16 do local av=x%2;x=math.floor(x/2);local bv=y%2;y=math.floor(y/2);if av~=bv then r=r+p end;p=p*2 end;return r end
@JUNK6
local ${n.Q}=(${n.REQ} and ${n.REQ}) or (${n.HREQ} and ${n.HREQ}) or ${n.REQ2} or ${n.HREQ2}
if not ${n.Q} then return end
@JUNK7
local function ${n.GET}(u) local ok,rs=pcall(${n.Q},{Url=u,Method=${n.GETM}});if not ok or not rs then return nil end;if (rs.StatusCode or rs.Status_code or 0)~=200 then return nil end;return rs.Body end
local ${n.S}=math.floor(math.random()*899999999999)+1
local ${n.N}=tonumber(${n.GET}(${n.A}..${n.U1}..${n.S}..${n.U2}..${n.K})) or nil
if not ${n.N} then return end
@JUNK8
local ${n.BK}=math.floor(os.time()/15)
local ${n.E}=${n.G}(${n.S},${n.N},${n.BK})
local ${n.LR}=tonumber(${n.GET}(${n.A}..${n.U3}..${n.E})) or nil
if not ${n.LR} then return end
local ${n.NV}=${n.N}+${n.S}-100000000000;if ${n.NV}<0 then ${n.NV}=-${n.NV} end
if ${n.LR}~=${n.G}(${n.E},${n.NV},${n.BK}) and ${n.LR}~=${n.G}(${n.E},${n.NV},${n.BK}-1) and ${n.LR}~=${n.G}(${n.E},${n.NV},${n.BK}+1) then return end
@JUNK9
@CHECK
@JUNK10
local ${n.SD}=${n.XA}(${n.R},${n.SL})+${n.XB}(${n.R},${n.SL})*65536
local ${n.SRC}=${n.X}(${n.PAY},${n.SD})
local ${n.FN},${n.FE}=loadstring(${n.SRC})
if not ${n.FN} then return end
return ${n.FN}()`;
}

// ── Public API ─────────────────────────────────────────

function buildChunk(opts) {
    const { userScript, apiBase, key, hwid, reply, versionHash } = opts;
    if (!userScript) throw new Error('EMPTY_SCRIPT');
    const replyNum = Math.floor(Number(reply));
    if (!Number.isFinite(replyNum)) throw new Error('BAD_REPLY');

    // Test-only overrides (deterministic verification); ignored otherwise.
    const salt = (Number.isInteger(opts._salt) && opts._salt >= 0)
        ? (opts._salt >>> 0) : crypto.randomInt(4294967296);
    const shape = [0, 1, 2].includes(opts._shape) ? opts._shape : crypto.randomInt(3);

    const used = new Set();
    const n = {};
    for (const t of ['R', 'K', 'H', 'A', 'B', 'D', 'X', 'M', 'G', 'F', 'Q', 'GET', 'S', 'N', 'BK', 'E', 'LR', 'NV', 'SRC', 'FN', 'FE', 'ABC', 'REQ', 'HREQ', 'REQ2', 'HREQ2', 'GETM', 'U1', 'U2', 'U3', 'PAY', 'XA', 'XB', 'SD', 'SL']) {
        n[t] = randName(used);
    }

    // Payload key: split 16/16 fold of (reply, salt). Neither closure
    // alone yields the seed, and nothing static crosses deliveries.
    const keySeed = foldSeed(replyNum, salt);
    const cipher = xorCrypt(Buffer.from(userScript, 'utf8'), keySeed);
    const payB64 = cipher.toString('base64');
    const payJSON = JSON.stringify(payB64);

    // Encrypted constants (fresh 1-byte key each)
    const cU1 = encConst('/api/nonce2?rngSeed=', used);
    const cU2 = encConst('&key=', used);
    const cU3 = encConst('/api/auth7?response=', used);
    const cGet = encConst('GET', used);

    // Salted sentinel, recomputed live in shape 0.
    const sentinel = fnv1a(String(versionHash) + '|' + salt + '|' + replyNum);
    // Ciphertext-prefix checksum for shape 2 (same slice both sides).
    const chk = fnv1a(payB64.slice(0, 24));

    let src = template(n);

    // Fixed runtime-global fallbacks + embedded literals.
    // Applied longest-token-first so no name is a substring casualty.
    const subs = [
        [n.REQ, '(syn and syn.request)'],
        [n.HREQ, '(http and http.request)'],
        [n.REQ2, 'request'],
        [n.HREQ2, 'http_request'],
        [n.ABC, JSON.stringify(B64ABC)],
        [n.GETM, n.D + '("' + cGet.b64 + '",' + cGet.k + ')'],
        [n.U1, n.D + '("' + cU1.b64 + '",' + cU1.k + ')'],
        [n.U2, n.D + '("' + cU2.b64 + '",' + cU2.k + ')'],
        [n.U3, n.D + '("' + cU3.b64 + '",' + cU3.k + ')'],
        [n.SL, String(salt)],
        [n.PAY, payJSON],
    ].sort((a, b) => b[0].length - a[0].length);
    for (const [tok, rep] of subs) src = src.split(tok).join(rep);

    // Rotating second factor (the live-reply recompute above is always
    // on). Shape 1 is branchless here — a forged value simply decrypts
    // to garbage. A hook script targeting one fixed pattern breaks on
    // the others.
    let checkStr;
    if (shape === 0) {
        checkStr = `if ${n.F}(${JSON.stringify(String(versionHash))}.."|"..(${salt}).."|"..${n.R})~=${sentinel} then return end`;
    } else if (shape === 2) {
        checkStr = `if ${n.F}((${payJSON}):sub(1,24))~=${chk} then return end`;
    } else {
        checkStr = '';
    }
    src = src.split('@CHECK').join(checkStr);

    // Junk injection (dead code only — never touches live locals).
    // Descending: '@JUNK1' is a prefix of '@JUNK10'.
    for (let j = 10; j >= 1; j--) {
        src = src.split('@JUNK' + j).join(junkBlock(used));
    }

    // Newline-only separators: no line ends with a lone ';'
    // (empty statement, illegal in Lua 5.1).
    const seps = ['\n', '\n\n', '\n'];
    src = src.split('\n').map(l => l + seps[crypto.randomInt(seps.length)]).join('');
    return src;
}

module.exports = { buildChunk, fnv1a, lcgStream, xorCrypt, encConst, foldSeed, B64ABC };
