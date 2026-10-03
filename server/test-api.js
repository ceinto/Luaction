// Quick API integration test
const http = require('http');

function req(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: 'localhost', port: 3000,
            path: '/api' + path, method,
            headers: { 'Content-Type': 'application/json' }
        };
        const r = http.request(opts, res => {
            let chunks = '';
            res.on('data', c => chunks += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(chunks) }); }
                catch { resolve({ status: res.statusCode, data: chunks }); }
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

async function run() {
    console.log('\n=== AntiFold Shield API Test ===\n');

    // 1. Health check
    let r = await req('GET', '/health');
    console.log('1. Health:', r.data.status === 'ok' ? 'PASS' : 'FAIL');

    // 2. Create project
    r = await req('POST', '/projects', { name: 'TestScript', description: 'Integration test' });
    console.log('2. Create project:', r.status === 201 ? 'PASS' : 'FAIL', '- ID:', r.data.id?.substring(0, 16));
    const projectId = r.data.id;
    const apiKey = r.data.api_key;

    // 3. Upload script to project
    r = await req('PATCH', `/projects/${projectId}`, {
        script_data: 'print("Hello from AntiFold Shield!")\nlocal x = 42\nprint("Protected value:", x)',
        version: '1.0.0'
    });
    console.log('3. Upload script:', r.status === 200 ? 'PASS' : 'FAIL', '- Hash:', r.data.version_hash);

    // 4. Generate a license key
    r = await req('POST', `/keys/${projectId}`, { note: 'Test key' });
    console.log('4. Create key:', r.status === 201 ? 'PASS' : 'FAIL', '- Key:', r.data.key_value);
    const keyValue = r.data.key_value;
    const keyId = r.data.id;

    // 5. Generate bulk keys
    r = await req('POST', `/keys/${projectId}`, { count: 5, note: 'Bulk batch' });
    console.log('5. Bulk keys:', r.status === 201 ? 'PASS' : 'FAIL', '- Created:', r.data.created);

    // 6. List keys
    r = await req('GET', `/keys/${projectId}`);
    console.log('6. List keys:', r.data.total === 6 ? 'PASS' : 'FAIL', '- Total:', r.data.total);

    // 7. Auth with valid key + new HWID (should bind)
    const fakeHwid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    r = await req('POST', '/auth', { key: keyValue, hwid: fakeHwid, version: '1.0.0' });
    console.log('7. Auth (first use):', r.status === 200 ? 'PASS' : 'FAIL', '- Status:', r.data.status);
    if (r.data.payload) {
        console.log('   Payload received: iv=' + r.data.payload.iv?.substring(0, 8) + '... tag=' + r.data.payload.tag?.substring(0, 8) + '...');
        console.log('   Encrypted data length:', r.data.payload.data?.length, 'hex chars');
    }

    // 8. Auth again with same HWID (should succeed)
    r = await req('POST', '/auth', { key: keyValue, hwid: fakeHwid, version: '1.0.0' });
    console.log('8. Auth (same HWID):', r.status === 200 ? 'PASS' : 'FAIL');

    // 9. Auth with different HWID (should fail - HWID_MISMATCH)
    r = await req('POST', '/auth', { key: keyValue, hwid: 'deadbeefdeadbeef', version: '1.0.0' });
    console.log('9. Auth (wrong HWID):', r.status === 403 && r.data.error === 'HWID_MISMATCH' ? 'PASS' : 'FAIL', '-', r.data.error);

    // 10. Auth with invalid key
    r = await req('POST', '/auth', { key: 'AF-FAKE-FAKE-FAKE-FAKE', hwid: fakeHwid, version: '1.0.0' });
    console.log('10. Auth (bad key):', r.status === 403 && r.data.error === 'INVALID_KEY' ? 'PASS' : 'FAIL', '-', r.data.error);

    // 11. Reset HWID
    r = await req('POST', `/keys/reset-hwid/${keyId}`);
    console.log('11. Reset HWID:', r.status === 200 ? 'PASS' : 'FAIL', '- HWID now:', r.data.key?.hwid);

    // 12. Blacklist key then try auth
    r = await req('PATCH', `/keys/update/${keyId}`, { is_blacklisted: 1 });
    console.log('12. Blacklist key:', r.status === 200 ? 'PASS' : 'FAIL');
    r = await req('POST', '/auth', { key: keyValue, hwid: fakeHwid, version: '1.0.0' });
    console.log('    Auth (blacklisted):', r.status === 403 && r.data.error === 'KEY_BLACKLISTED' ? 'PASS' : 'FAIL', '-', r.data.error);

    // Unblacklist for next tests
    await req('PATCH', `/keys/update/${keyId}`, { is_blacklisted: 0 });

    // 13. Kill switch
    r = await req('PATCH', `/projects/${projectId}`, { kill_switch: 1 });
    console.log('13. Kill switch ON:', r.status === 200 ? 'PASS' : 'FAIL');
    r = await req('POST', '/auth', { key: keyValue, hwid: fakeHwid, version: '1.0.0' });
    console.log('    Auth (killed):', r.status === 403 && r.data.error === 'PROJECT_KILLED' ? 'PASS' : 'FAIL', '-', r.data.error);

    // Reactivate
    await req('PATCH', `/projects/${projectId}`, { kill_switch: 0 });

    // 14. Version check
    r = await req('GET', `/version/${projectId}`);
    console.log('14. Version check:', r.status === 200 ? 'PASS' : 'FAIL', '- v' + r.data.version, 'hash:', r.data.version_hash);

    // 15. Get stats
    r = await req('GET', `/stats/${projectId}`);
    console.log('15. Stats:', r.status === 200 ? 'PASS' : 'FAIL', '- Keys:', r.data.total_keys, 'Auths:', r.data.total_auths);

    // 16. Auth logs
    r = await req('GET', `/logs/${projectId}`);
    console.log('16. Auth logs:', Array.isArray(r.data) ? 'PASS' : 'FAIL', '- Entries:', r.data.length);

    console.log('\n=== All tests complete ===\n');
    process.exit(0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
