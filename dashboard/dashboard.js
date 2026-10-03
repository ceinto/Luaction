// ═══════════════════════════════════════════════════════
//  Luaction — Dashboard Logic
// ═══════════════════════════════════════════════════════

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000/api'
    : 'https://luaction-api.onrender.com/api';
let currentPage = 'projects';
let currentProjectId = null;
let projects = [];

// ── Toast Notifications ──────────────────────────────

function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const colors = {
        success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        error: 'border-red-500/30 bg-red-500/10 text-red-300',
        info: 'border-blue-500/30 bg-blue-500/10 text-blue-300'
    };
    const icons = {
        success: '✓',
        error: '✕',
        info: 'ℹ'
    };

    const el = document.createElement('div');
    el.className = `toast-in glass px-4 py-3 rounded-xl border ${colors[type]} text-sm font-medium flex items-center gap-2 min-w-[280px]`;
    el.innerHTML = `<span class="text-base">${icons[type]}</span> ${message}`;
    container.appendChild(el);

    setTimeout(() => {
        el.classList.remove('toast-in');
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

// ── Modal System ─────────────────────────────────────

function showModal(html) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = html;
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
}

function hideModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
}

document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideModal();
});

// ── Navigation ───────────────────────────────────────

document.querySelectorAll('.sidebar-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        switchPage(page);
    });
});

function switchPage(page) {
    currentPage = page;
    document.querySelectorAll('.sidebar-link').forEach(l => {
        l.classList.remove('active');
        l.classList.add('text-gray-400');
    });
    const active = document.querySelector(`[data-page="${page}"]`);
    if (active) {
        active.classList.add('active');
        active.classList.remove('text-gray-400');
    }

    const titles = {
        projects: ['Projects', 'Manage your protected scripts'],
        keys: ['License Keys', currentProjectId ? 'Manage keys for this project' : 'Select a project first'],
        logs: ['Auth Logs', 'Real-time authentication events']
    };
    document.getElementById('page-title').textContent = titles[page]?.[0] || page;
    document.getElementById('page-subtitle').textContent = titles[page]?.[1] || '';

    renderPage();
}

// ── API Helpers ──────────────────────────────────────

async function api(path, opts = {}) {
    try {
        const apiKey = sessionStorage.getItem('luaction_key');
        const headers = { 'Content-Type': 'application/json', ...opts.headers };
        if (apiKey) headers['X-API-Key'] = apiKey;

        const res = await fetch(`${API}${path}`, {
            headers: headers,
            ...opts
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Request failed');
        return data;
    } catch (err) {
        if (err.message === 'Failed to fetch') {
            throw new Error('Cannot connect to server');
        }
        throw err;
    }
}

// ── Render Pages ─────────────────────────────────────

function renderPage() {
    switch (currentPage) {
        case 'projects': renderProjects(); break;
        case 'keys': renderKeys(); break;
        case 'logs': renderLogs(); break;
    }
}

// ── Projects Page ────────────────────────────────────

async function renderProjects() {
    const area = document.getElementById('content-area');
    area.innerHTML = '<div class="flex items-center justify-center h-40"><div class="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div></div>';

    try {
        projects = await api('/projects');
        if (projects.length === 0) {
            area.innerHTML = `
                <div class="flex flex-col items-center justify-center h-64 text-center fade-up">
                    <div class="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
                        <svg class="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
                    </div>
                    <h3 class="text-sm font-medium text-gray-300 mb-1">No projects yet</h3>
                    <p class="text-xs text-gray-500 mb-4">Create your first project to get started</p>
                    <button onclick="showCreateModal()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-all">Create Project</button>
                </div>`;
            return;
        }

        // Fetch stats for each project
        const statsPromises = projects.map(p => api(`/stats/${p.id}`).catch(() => null));
        const allStats = await Promise.all(statsPromises);

        let html = '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">';
        projects.forEach((p, i) => {
            const stats = allStats[i] || {};
            const isKilled = !!p.kill_switch;
            const cpSteps = parseCpSteps(p);
            const cpOn = !!p.checkpoint_enabled && cpSteps.length > 0;
            html += `
            <div class="glass rounded-2xl p-5 fade-up cursor-pointer hover:border-white/10 transition-all duration-200 group" onclick="selectProject('${p.id}')" style="animation-delay: ${i * 60}ms">
                <div class="flex items-start justify-between mb-4">
                    <div>
                        <h3 class="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors">${esc(p.name)}</h3>
                        <p class="text-[11px] text-gray-500 mt-0.5 font-mono">${p.id.substring(0, 16)}...</p>
                    </div>
                    <div class="flex flex-col items-end gap-1.5">
                    <div class="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium ${isKilled ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}">
                        <span class="w-1.5 h-1.5 rounded-full ${isKilled ? 'bg-red-400' : 'bg-emerald-400 pulse-dot'}"></span>
                        ${isKilled ? 'Killed' : 'Active'}
                    </div>
                    <div class="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium ${cpOn ? 'bg-violet-500/10 text-violet-300' : 'bg-white/5 text-gray-500'}">
                        ☑ ${cpOn ? cpSteps.length + ' step' + (cpSteps.length > 1 ? 's' : '') : 'No checkpoint'}
                    </div>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-3">
                    <div class="bg-white/[0.03] rounded-xl p-3 text-center">
                        <p class="text-lg font-bold text-white">${stats.total_keys || 0}</p>
                        <p class="text-[10px] text-gray-500 mt-0.5">Keys</p>
                    </div>
                    <div class="bg-white/[0.03] rounded-xl p-3 text-center">
                        <p class="text-lg font-bold text-white">${stats.success_auths || 0}</p>
                        <p class="text-[10px] text-gray-500 mt-0.5">Auths</p>
                    </div>
                    <div class="bg-white/[0.03] rounded-xl p-3 text-center">
                        <p class="text-lg font-bold text-white">${stats.auths_24h || 0}</p>
                        <p class="text-[10px] text-gray-500 mt-0.5">24h</p>
                    </div>
                </div>
                <div class="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
                    <span class="text-[10px] text-gray-500">v${esc(p.version)}</span>
                    <div class="flex items-center gap-2">
                        <button onclick="event.stopPropagation(); showCheckpointModal('${p.id}')" class="text-[10px] px-2 py-1 rounded-md ${cpOn ? 'bg-violet-500/10 text-violet-300 hover:bg-violet-500/20' : 'bg-white/5 text-gray-400 hover:bg-violet-500/10 hover:text-violet-300'} transition-all" title="Linkvertise checkpoint steps">
                            ☑ Checkpoint
                        </button>
                        <button onclick="event.stopPropagation(); toggleKillSwitch('${p.id}', ${!isKilled})" class="text-[10px] px-2 py-1 rounded-md ${isKilled ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'} transition-all" title="${isKilled ? 'Reactivate' : 'Kill Switch'}">
                            ${isKilled ? 'Activate' : 'Kill'}
                        </button>
                        <button onclick="event.stopPropagation(); deleteProject('${p.id}')" class="text-[10px] px-2 py-1 rounded-md bg-white/5 text-gray-400 hover:bg-red-500/10 hover:text-red-400 transition-all">Delete</button>
                    </div>
                </div>
            </div>`;
        });
        html += '</div>';
        area.innerHTML = html;

    } catch (err) {
        area.innerHTML = `<div class="text-center py-20 text-gray-500 text-sm">Failed to load: ${esc(err.message)}</div>`;
    }
}

function selectProject(id) {
    currentProjectId = id;
    switchPage('keys');
}

async function toggleKillSwitch(id, value) {
    try {
        await api(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ kill_switch: value ? 1 : 0 }) });
        toast(value ? 'Project killed' : 'Project reactivated', value ? 'error' : 'success');
        renderProjects();
    } catch (err) { toast(err.message, 'error'); }
}

async function deleteProject(id) {
    if (!confirm('Delete this project and all its keys? This cannot be undone.')) return;
    try {
        await api(`/projects/${id}`, { method: 'DELETE' });
        toast('Project deleted', 'success');
        renderProjects();
    } catch (err) { toast(err.message, 'error'); }
}

// ── Checkpoint (Linkvertise) ───────────────────────────

function parseCpSteps(p) {
    if (!p || !p.checkpoint_steps) return [];
    try {
        const v = typeof p.checkpoint_steps === 'string' ? JSON.parse(p.checkpoint_steps) : p.checkpoint_steps;
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}

function checkpointPageUrl(projectId) {
    const base = window.location.origin;
    // Served from /loader static; works locally and on Render
    const path = window.location.pathname.includes('/dashboard')
        ? window.location.pathname.replace('/dashboard', '/loader').replace(/\/[^/]*$/, '/checkpoint.html')
        : '/loader/checkpoint.html';
    return `${base}${path}?project=${projectId}`;
}

async function showCheckpointModal(projectId) {
    let p;
    try { p = await api(`/projects/${projectId}`); }
    catch (err) { toast(err.message, 'error'); return; }

    const steps = parseCpSteps(p);
    while (steps.length < 1) steps.push('');
    const enabled = !!p.checkpoint_enabled;
    const token = p.linkvertise_token || '';
    const cooldown = p.checkpoint_cooldown_hours || 24;

    const stepsHtml = steps.map((s, i) => `
        <div class="flex items-center gap-2" data-cp-step="${i}">
            <span class="text-[10px] font-mono text-gray-500 w-10 shrink-0">Step ${i + 1}</span>
            <input data-cp-url type="text" value="${esc(s)}" placeholder="https://linkvertise.com/..." class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/50 transition-colors font-mono">
            ${steps.length > 1 ? `<button onclick="removeCpStep(this)" class="text-gray-500 hover:text-red-400 text-sm px-1 shrink-0">✕</button>` : ''}
        </div>`).join('');

    showModal(`
        <h3 class="text-base font-semibold text-white mb-1">☑ Checkpoint — ${esc(p.name)}</h3>
        <p class="text-[11px] text-gray-500 mb-4">Users complete your Linkvertise link(s) to claim a key and to authenticate. Verified server-side via Anti-Bypass.</p>
        <div class="space-y-3">
            <label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input id="cp-enabled" type="checkbox" ${enabled ? 'checked' : ''} class="accent-violet-500 w-4 h-4">
                Enable checkpoint for this project
            </label>
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Linkvertise API token <span class="text-gray-600">(publisher.linkvertise.com → API — or <span class="font-mono">BYPASS</span> for local testing)</span></label>
                <input id="cp-token" type="password" value="${esc(token)}" placeholder="64-char token or BYPASS" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/50 transition-colors font-mono">
            </div>
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Token validity after completion (hours)</label>
                <input id="cp-cooldown" type="number" value="${cooldown}" min="1" max="720" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-violet-500/50 transition-colors">
            </div>
            <div>
                <div class="flex items-center justify-between mb-1">
                    <label class="text-[11px] text-gray-400 font-medium">Linkvertise links (1–5 steps)</label>
                    <button onclick="addCpStep()" class="text-[11px] text-violet-300 hover:text-violet-200">+ Add step</button>
                </div>
                <div id="cp-steps" class="space-y-2">${stepsHtml}</div>
            </div>
            <div class="bg-white/[0.03] border border-white/5 rounded-lg p-3">
                <p class="text-[11px] text-gray-400 font-medium mb-1">Linkvertise setup (per step)</p>
                <ol class="text-[11px] text-gray-500 space-y-0.5 list-decimal list-inside">
                    <li>Create a link at publisher.linkvertise.com</li>
                    <li>Set its <span class="text-gray-300">Target URL</span> to the step URL below, then <button onclick="copyCpTargets('${p.id}')" class="text-violet-300 hover:text-violet-200 underline">copy all</button></li>
                    <li>Turn <span class="text-gray-300">Anti-Bypass ON</span> for the link</li>
                </ol>
                <div id="cp-targets" class="mt-2 text-[10px] font-mono text-gray-600">Loading target URLs…</div>
            </div>
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">User-facing checkpoint page (share this)</label>
                <div class="flex items-center gap-2">
                    <input type="text" readonly value="${checkpointPageUrl(p.id)}" onclick="this.select()" class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-gray-400 font-mono focus:outline-none">
                    <button onclick="copyText('${checkpointPageUrl(p.id)}')" class="px-3 py-2 bg-white/5 hover:bg-white/10 text-gray-300 text-[11px] rounded-lg transition-all shrink-0">Copy</button>
                </div>
            </div>
        </div>
        <div class="flex justify-end gap-2 mt-5">
            <button onclick="hideModal()" class="px-4 py-2 text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button onclick="saveCheckpoint('${p.id}')" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg transition-all">Save checkpoint</button>
        </div>
    `);
    loadCpTargets(projectId);
}

async function loadCpTargets(projectId) {
    try {
        const data = await api(`/checkpoint/targets/${projectId}`);
        const el = document.getElementById('cp-targets');
        if (el) el.innerHTML = data.targets.map((t, i) => `<div class="truncate" title="${esc(t)}">Step ${i + 1}: <span class="text-gray-400">${esc(t)}</span></div>`).join('');
    } catch {
        const el = document.getElementById('cp-targets');
        if (el) el.textContent = 'Could not load target URLs.';
    }
}

async function copyCpTargets(projectId) {
    try {
        const data = await api(`/checkpoint/targets/${projectId}`);
        await navigator.clipboard.writeText(data.targets.join('\n'));
        toast('Target URLs copied', 'info');
    } catch (err) { toast(err.message, 'error'); }
}

function addCpStep() {
    const box = document.getElementById('cp-steps');
    const count = box.querySelectorAll('[data-cp-step]').length;
    if (count >= 5) { toast('Maximum 5 steps', 'error'); return; }
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2';
    div.dataset.cpStep = count;
    div.innerHTML = `
        <span class="text-[10px] font-mono text-gray-500 w-10 shrink-0">Step ${count + 1}</span>
        <input data-cp-url type="text" value="" placeholder="https://linkvertise.com/..." class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/50 transition-colors font-mono">
        <button onclick="removeCpStep(this)" class="text-gray-500 hover:text-red-400 text-sm px-1 shrink-0">✕</button>`;
    box.appendChild(div);
}

function removeCpStep(btn) {
    btn.closest('[data-cp-step]').remove();
    document.querySelectorAll('#cp-steps [data-cp-step]').forEach((row, i) => {
        row.dataset.cpStep = i;
        row.querySelector('span').textContent = `Step ${i + 1}`;
    });
}

async function saveCheckpoint(projectId) {
    const enabled = document.getElementById('cp-enabled').checked;
    const token = document.getElementById('cp-token').value.trim();
    const cooldown = parseInt(document.getElementById('cp-cooldown').value) || 24;
    const urls = [...document.querySelectorAll('#cp-steps [data-cp-url]')].map(i => i.value.trim()).filter(Boolean);

    if (enabled && urls.length === 0) { toast('Add at least one Linkvertise link', 'error'); return; }

    try {
        await api(`/projects/${projectId}`, {
            method: 'PATCH',
            body: JSON.stringify({
                checkpoint_enabled: enabled ? 1 : 0,
                checkpoint_steps: urls,
                linkvertise_token: token,
                checkpoint_cooldown_hours: cooldown
            })
        });
        hideModal();
        toast('Checkpoint saved', 'success');
        renderProjects();
    } catch (err) { toast(err.message, 'error'); }
}

// ── Keys Page ────────────────────────────────────────

async function renderKeys() {
    const area = document.getElementById('content-area');
    if (!currentProjectId) {
        area.innerHTML = '<div class="text-center py-20 text-gray-500 text-sm">Select a project first</div>';
        return;
    }

    area.innerHTML = '<div class="flex items-center justify-center h-40"><div class="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div></div>';

    try {
        const project = await api(`/projects/${currentProjectId}`);
        const data = await api(`/keys/${currentProjectId}`);
        const keys = data.keys;
        const cpSteps = parseCpSteps(project);
        const cpOn = !!project.checkpoint_enabled && cpSteps.length > 0;

        let html = `
        <div class="mb-6 flex items-center justify-between">
            <div>
                <h3 class="text-sm font-semibold text-white">${esc(project.name)}</h3>
                <p class="text-xs text-gray-500">${data.total} total keys · ${cpOn ? `☑ Checkpoint ON (${cpSteps.length} step${cpSteps.length > 1 ? 's' : ''})` : 'Checkpoint off'}</p>
            </div>
            <div class="flex gap-2">
                <button onclick="showCheckpointModal('${esc(project.id)}')" class="px-3 py-1.5 bg-white/5 hover:bg-violet-500/10 hover:text-violet-300 text-gray-300 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5">
                    ☑ Checkpoint
                </button>
                <button onclick="showCreateKeyModal()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-all flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                    Generate Keys
                </button>
            </div>
        </div>`;

        if (keys.length === 0) {
            html += '<div class="text-center py-16 text-gray-500 text-sm">No keys yet. Generate some!</div>';
        } else {
            html += `
            <div class="glass rounded-2xl overflow-hidden">
                <table class="w-full text-xs">
                    <thead>
                        <tr class="border-b border-white/5">
                            <th class="text-left px-4 py-3 text-gray-500 font-medium">Key</th>
                            <th class="text-left px-4 py-3 text-gray-500 font-medium">HWID</th>
                            <th class="text-left px-4 py-3 text-gray-500 font-medium">Status</th>
                            <th class="text-left px-4 py-3 text-gray-500 font-medium">Uses</th>
                            <th class="text-left px-4 py-3 text-gray-500 font-medium">Expires</th>
                            <th class="text-left px-4 py-3 text-gray-500 font-medium">Last Used</th>
                            <th class="text-right px-4 py-3 text-gray-500 font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>`;

            keys.forEach(k => {
                const statusClass = k.is_blacklisted ? 'bg-red-500/10 text-red-400' : k.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-yellow-500/10 text-yellow-400';
                const statusText = k.is_blacklisted ? 'Blacklisted' : k.is_active ? 'Active' : 'Disabled';
                const hwidShort = k.hwid ? k.hwid.substring(0, 12) + '...' : '—';
                const expiresAt = k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'Lifetime';
                const lastUsed = k.last_used ? timeAgo(k.last_used) : 'Never';

                html += `
                    <tr class="table-row border-b border-white/[0.03]">
                        <td class="px-4 py-3 font-mono text-gray-300 cursor-pointer hover:text-blue-400 transition-colors" onclick="copyText('${esc(k.key_value)}')" title="Click to copy">${esc(k.key_value)}</td>
                        <td class="px-4 py-3 font-mono text-gray-500">${hwidShort}</td>
                        <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-medium ${statusClass}">${statusText}</span></td>
                        <td class="px-4 py-3 text-gray-400">${k.use_count}${k.max_uses > 0 ? '/' + k.max_uses : ''}</td>
                        <td class="px-4 py-3 text-gray-500">${expiresAt}</td>
                        <td class="px-4 py-3 text-gray-500">${lastUsed}</td>
                        <td class="px-4 py-3 text-right">
                            <div class="flex items-center justify-end gap-1">
                                ${k.hwid ? `<button onclick="resetHwid('${k.id}')" class="px-2 py-1 rounded-md bg-white/5 text-gray-400 hover:bg-blue-500/10 hover:text-blue-400 transition-all text-[10px]">Reset HWID</button>` : ''}
                                <button onclick="toggleKey('${k.id}', ${k.is_active ? 0 : 1})" class="px-2 py-1 rounded-md bg-white/5 text-gray-400 hover:bg-yellow-500/10 hover:text-yellow-400 transition-all text-[10px]">${k.is_active ? 'Disable' : 'Enable'}</button>
                                <button onclick="blacklistKey('${k.id}', ${k.is_blacklisted ? 0 : 1})" class="px-2 py-1 rounded-md bg-white/5 text-gray-400 hover:bg-red-500/10 hover:text-red-400 transition-all text-[10px]">${k.is_blacklisted ? 'Unblock' : 'Block'}</button>
                                <button onclick="deleteKey('${k.id}')" class="px-2 py-1 rounded-md bg-white/5 text-gray-400 hover:bg-red-500/10 hover:text-red-400 transition-all text-[10px]">✕</button>
                            </div>
                        </td>
                    </tr>`;
            });

            html += '</tbody></table></div>';
        }

        area.innerHTML = html;
    } catch (err) {
        area.innerHTML = `<div class="text-center py-20 text-gray-500 text-sm">Error: ${esc(err.message)}</div>`;
    }
}

// ── Key Actions ──────────────────────────────────────

async function resetHwid(keyId) {
    try {
        await api(`/keys/reset-hwid/${keyId}`, { method: 'POST' });
        toast('HWID reset', 'success');
        renderKeys();
    } catch (err) { toast(err.message, 'error'); }
}

async function toggleKey(keyId, active) {
    try {
        await api(`/keys/update/${keyId}`, { method: 'PATCH', body: JSON.stringify({ is_active: active }) });
        toast(active ? 'Key enabled' : 'Key disabled', 'info');
        renderKeys();
    } catch (err) { toast(err.message, 'error'); }
}

async function blacklistKey(keyId, blacklisted) {
    try {
        await api(`/keys/update/${keyId}`, { method: 'PATCH', body: JSON.stringify({ is_blacklisted: blacklisted }) });
        toast(blacklisted ? 'Key blacklisted' : 'Key unblocked', blacklisted ? 'error' : 'success');
        renderKeys();
    } catch (err) { toast(err.message, 'error'); }
}

async function deleteKey(keyId) {
    try {
        await api(`/keys/${keyId}`, { method: 'DELETE' });
        toast('Key deleted', 'success');
        renderKeys();
    } catch (err) { toast(err.message, 'error'); }
}

// ── Logs Page ────────────────────────────────────────

async function renderLogs() {
    const area = document.getElementById('content-area');
    if (!currentProjectId) {
        area.innerHTML = '<div class="text-center py-20 text-gray-500 text-sm">Select a project first</div>';
        return;
    }

    area.innerHTML = '<div class="flex items-center justify-center h-40"><div class="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div></div>';

    try {
        const logs = await api(`/logs/${currentProjectId}`);

        if (logs.length === 0) {
            area.innerHTML = '<div class="text-center py-16 text-gray-500 text-sm">No auth logs yet</div>';
            return;
        }

        let html = '<div class="space-y-2">';
        logs.forEach((log, i) => {
            const isSuccess = log.status === 'SUCCESS';
            const statusColors = {
                'SUCCESS': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                'HWID_MISMATCH': 'bg-red-500/10 text-red-400 border-red-500/20',
                'KEY_EXPIRED': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                'KEY_BLACKLISTED': 'bg-red-500/10 text-red-400 border-red-500/20',
                'PROJECT_KILLED': 'bg-red-500/10 text-red-400 border-red-500/20',
                'KEY_DISABLED': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                'INVALID_KEY': 'bg-gray-500/10 text-gray-400 border-gray-500/20'
            };
            const color = statusColors[log.status] || 'bg-gray-500/10 text-gray-400 border-gray-500/20';

            html += `
            <div class="glass rounded-xl px-4 py-3 flex items-center justify-between fade-up" style="animation-delay: ${i * 30}ms">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg ${isSuccess ? 'bg-emerald-500/10' : 'bg-red-500/10'} flex items-center justify-center">
                        <span class="text-sm">${isSuccess ? '✓' : '✕'}</span>
                    </div>
                    <div>
                        <p class="text-xs font-medium text-gray-300 font-mono">${log.key_value ? esc(log.key_value) : 'Unknown'}</p>
                        <p class="text-[10px] text-gray-500 mt-0.5">${log.ip_address || '?'} · ${log.hwid ? log.hwid.substring(0, 12) + '...' : 'No HWID'}</p>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-medium border ${color}">${log.status}</span>
                    <span class="text-[10px] text-gray-600">${timeAgo(log.created_at)}</span>
                </div>
            </div>`;
        });
        html += '</div>';
        area.innerHTML = html;
    } catch (err) {
        area.innerHTML = `<div class="text-center py-20 text-gray-500 text-sm">Error: ${esc(err.message)}</div>`;
    }
}

// ── Modals ───────────────────────────────────────────

function showCreateModal() {
    if (currentPage === 'keys') {
        showCreateKeyModal();
        return;
    }
    showModal(`
        <h3 class="text-base font-semibold text-white mb-4">Create Project</h3>
        <div class="space-y-3">
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Project Name</label>
                <input id="modal-name" type="text" placeholder="My Script" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors">
            </div>
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Description</label>
                <input id="modal-desc" type="text" placeholder="Optional description" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors">
            </div>
        </div>
        <div class="flex justify-end gap-2 mt-5">
            <button onclick="hideModal()" class="px-4 py-2 text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button onclick="createProject()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-all">Create</button>
        </div>
    `);
    setTimeout(() => document.getElementById('modal-name')?.focus(), 100);
}

function showCreateKeyModal() {
    showModal(`
        <h3 class="text-base font-semibold text-white mb-4">Generate Keys</h3>
        <div class="space-y-3">
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Number of Keys</label>
                <input id="modal-count" type="number" value="1" min="1" max="500" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50 transition-colors">
            </div>
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Expiry (optional)</label>
                <input id="modal-expiry" type="datetime-local" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50 transition-colors">
            </div>
            <div>
                <label class="text-[11px] text-gray-400 font-medium mb-1 block">Note (optional)</label>
                <input id="modal-note" type="text" placeholder="Batch label" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors">
            </div>
        </div>
        <div class="flex justify-end gap-2 mt-5">
            <button onclick="hideModal()" class="px-4 py-2 text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button onclick="createKeys()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-all">Generate</button>
        </div>
    `);
}

// ── Create Actions ───────────────────────────────────

async function createProject() {
    const name = document.getElementById('modal-name').value.trim();
    const desc = document.getElementById('modal-desc').value.trim();
    if (!name) { toast('Project name is required', 'error'); return; }

    try {
        const project = await api('/projects', { method: 'POST', body: JSON.stringify({ name, description: desc }) });
        hideModal();
        toast('Project created', 'success');
        renderProjects();
    } catch (err) { toast(err.message, 'error'); }
}

async function createKeys() {
    const count = parseInt(document.getElementById('modal-count').value) || 1;
    const expiry = document.getElementById('modal-expiry').value || null;
    const note = document.getElementById('modal-note').value.trim();

    try {
        const result = await api(`/keys/${currentProjectId}`, {
            method: 'POST',
            body: JSON.stringify({ count, expires_at: expiry, note })
        });
        hideModal();
        toast(`${result.created || 1} key(s) generated`, 'success');
        renderKeys();
    } catch (err) { toast(err.message, 'error'); }
}

// ── Utilities ────────────────────────────────────────

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function copyText(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'info'));
}

function timeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
}

// ── Server Health Check ──────────────────────────────

async function checkServer() {
    try {
        await api('/health');
        document.getElementById('server-status').textContent = 'Server online';
    } catch {
        document.getElementById('server-status').textContent = 'Server offline';
    }
}

// ── Init ─────────────────────────────────────────────
checkServer();
renderProjects();
setInterval(checkServer, 15000);

