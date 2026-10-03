/*
 * Luaction — Native Client Loader
 * HWID collection, server auth, AES-256-GCM decryption
 * Zero external dependencies: WinHTTP + CNG only
 */
#include "loader.h"

// ══════════════════════════════════════════════════════
//  Hex Utilities
// ══════════════════════════════════════════════════════

static int hex_char_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int af_hex_decode(const char* hex, BYTE* out, DWORD out_size) {
    DWORD len = (DWORD)strlen(hex);
    if (len % 2 != 0 || len / 2 > out_size) return -1;
    for (DWORD i = 0; i < len; i += 2) {
        int hi = hex_char_val(hex[i]);
        int lo = hex_char_val(hex[i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i / 2] = (BYTE)((hi << 4) | lo);
    }
    return (int)(len / 2);
}

void af_hex_encode(const BYTE* data, DWORD data_len, char* out) {
    static const char hex[] = "0123456789abcdef";
    for (DWORD i = 0; i < data_len; i++) {
        out[i * 2]     = hex[(data[i] >> 4) & 0xF];
        out[i * 2 + 1] = hex[data[i] & 0xF];
    }
    out[data_len * 2] = '\0';
}

// ══════════════════════════════════════════════════════
//  SHA-256 via CNG (bcrypt.h)
// ══════════════════════════════════════════════════════

int af_sha256(const BYTE* data, DWORD data_len, BYTE* out_hash) {
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    NTSTATUS status;
    int ret = -1;

    status = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptHashData(hash, (PUCHAR)data, data_len, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptFinishHash(hash, out_hash, 32, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    ret = 0;

cleanup:
    if (hash) BCryptDestroyHash(hash);
    if (alg)  BCryptCloseAlgorithmProvider(alg, 0);
    return ret;
}

// ══════════════════════════════════════════════════════
//  HMAC-SHA256 via CNG
// ══════════════════════════════════════════════════════

static int hmac_sha256(const BYTE* key, DWORD key_len,
                       const BYTE* data, DWORD data_len,
                       BYTE* out_mac) {
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    NTSTATUS status;
    int ret = -1;

    status = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL,
                                         BCRYPT_ALG_HANDLE_HMAC_FLAG);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptCreateHash(alg, &hash, NULL, 0, (PUCHAR)key, key_len, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptHashData(hash, (PUCHAR)data, data_len, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptFinishHash(hash, out_mac, 32, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    ret = 0;

cleanup:
    if (hash) BCryptDestroyHash(hash);
    if (alg)  BCryptCloseAlgorithmProvider(alg, 0);
    return ret;
}

// ══════════════════════════════════════════════════════
//  HKDF Key Derivation (manual, matches Node.js server)
// ══════════════════════════════════════════════════════

int af_hkdf_derive(const BYTE* master_key, DWORD mk_len,
                   const BYTE* hwid_hash, const BYTE* nonce, DWORD nonce_len,
                   BYTE* out_key, DWORD key_len) {
    BYTE prk[32];
    BYTE info_plus_counter[256];
    BYTE t1[32];

    (void)key_len; // always 32 for AES-256

    // PRK = HMAC-SHA256(salt=hwid_hash, ikm=master_key)
    // Note: on server, salt = SHA256(hwid), ikm = master_key_bytes
    if (hmac_sha256(hwid_hash, 32, master_key, mk_len, prk) != 0)
        return -1;

    // T(1) = HMAC-SHA256(PRK, info || 0x01)
    if (nonce_len > 250) return -1;
    memcpy(info_plus_counter, nonce, nonce_len);
    info_plus_counter[nonce_len] = 0x01;

    if (hmac_sha256(prk, 32, info_plus_counter, nonce_len + 1, t1) != 0)
        return -1;

    memcpy(out_key, t1, 32);

    SecureZeroMemory(prk, sizeof(prk));
    SecureZeroMemory(t1, sizeof(t1));
    return 0;
}

// ══════════════════════════════════════════════════════
//  AES-256-GCM Decryption via CNG
// ══════════════════════════════════════════════════════

int af_aes_gcm_decrypt(const BYTE* key, DWORD key_len,
                       const BYTE* iv, DWORD iv_len,
                       const BYTE* tag, DWORD tag_len,
                       const BYTE* ciphertext, DWORD ct_len,
                       BYTE* plaintext, DWORD* pt_len) {
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_KEY_HANDLE hkey = NULL;
    NTSTATUS status;
    int ret = -1;

    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO authInfo;
    BCRYPT_INIT_AUTH_MODE_INFO(authInfo);
    authInfo.pbNonce = (PUCHAR)iv;
    authInfo.cbNonce = iv_len;
    authInfo.pbTag   = (PUCHAR)tag;
    authInfo.cbTag   = tag_len;

    status = BCryptOpenAlgorithmProvider(&alg, BCRYPT_AES_ALGORITHM, NULL, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptSetProperty(alg, BCRYPT_CHAINING_MODE,
                               (PUCHAR)BCRYPT_CHAIN_MODE_GCM,
                               sizeof(BCRYPT_CHAIN_MODE_GCM), 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    status = BCryptGenerateSymmetricKey(alg, &hkey, NULL, 0,
                                        (PUCHAR)key, key_len, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    *pt_len = ct_len;
    status = BCryptDecrypt(hkey, (PUCHAR)ciphertext, ct_len,
                           &authInfo, NULL, 0,
                           plaintext, ct_len, pt_len, 0);
    if (!BCRYPT_SUCCESS(status)) goto cleanup;

    ret = 0;

cleanup:
    if (hkey) BCryptDestroyKey(hkey);
    if (alg)  BCryptCloseAlgorithmProvider(alg, 0);
    return ret;
}

// ══════════════════════════════════════════════════════
//  HWID Generation
//  disk_serial + cpu_id + machine_name → SHA256 → hex
// ══════════════════════════════════════════════════════

int af_generate_hwid(char* out_hwid, DWORD out_size) {
    if (out_size < 65) return AF_ERR_HWID;

    char raw[512];
    int offset = 0;

    // 1. Disk volume serial
    DWORD vol_serial = 0;
    if (GetVolumeInformationA("C:\\", NULL, 0, &vol_serial, NULL, NULL, NULL, 0)) {
        offset += sprintf_s(raw + offset, sizeof(raw) - offset, "VOL:%08X|", vol_serial);
    }

    // 2. CPU ID via __cpuid
    int cpu_info[4] = {0};
    __cpuid(cpu_info, 0);
    offset += sprintf_s(raw + offset, sizeof(raw) - offset,
                        "CPU:%08X%08X%08X|", cpu_info[1], cpu_info[2], cpu_info[3]);

    __cpuid(cpu_info, 1);
    offset += sprintf_s(raw + offset, sizeof(raw) - offset,
                        "CPUF:%08X|", cpu_info[0]);

    // 3. Computer name
    char comp_name[MAX_COMPUTERNAME_LENGTH + 1];
    DWORD comp_size = sizeof(comp_name);
    if (GetComputerNameA(comp_name, &comp_size)) {
        offset += sprintf_s(raw + offset, sizeof(raw) - offset, "PC:%s|", comp_name);
    }

    // 4. Windows product ID from registry
    HKEY hkey;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
                      "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
                      0, KEY_READ | KEY_WOW64_64KEY, &hkey) == ERROR_SUCCESS) {
        char product_id[128] = {0};
        DWORD pid_size = sizeof(product_id);
        DWORD type = REG_SZ;
        if (RegQueryValueExA(hkey, "ProductId", NULL, &type,
                             (LPBYTE)product_id, &pid_size) == ERROR_SUCCESS) {
            offset += sprintf_s(raw + offset, sizeof(raw) - offset, "PID:%s", product_id);
        }
        RegCloseKey(hkey);
    }

    // Hash it all
    BYTE hash[32];
    if (af_sha256((const BYTE*)raw, offset, hash) != 0) {
        return AF_ERR_HWID;
    }

    af_hex_encode(hash, 32, out_hwid);

    // Wipe raw data
    SecureZeroMemory(raw, sizeof(raw));
    return AF_OK;
}

// ══════════════════════════════════════════════════════
//  Minimal JSON Parser (no deps, handles our API format)
// ══════════════════════════════════════════════════════

int af_json_get_string(const char* json, const char* key, char* out, DWORD out_size) {
    char pattern[128];
    sprintf_s(pattern, sizeof(pattern), "\"%s\"", key);

    const char* pos = strstr(json, pattern);
    if (!pos) return -1;

    pos += strlen(pattern);
    // skip whitespace and colon
    while (*pos && (*pos == ' ' || *pos == ':' || *pos == '\t')) pos++;
    if (*pos != '"') return -1;
    pos++; // skip opening quote

    DWORD i = 0;
    while (*pos && *pos != '"' && i < out_size - 1) {
        if (*pos == '\\' && *(pos + 1)) {
            pos++; // skip escape
            if (*pos == 'n') out[i++] = '\n';
            else if (*pos == 't') out[i++] = '\t';
            else if (*pos == '"') out[i++] = '"';
            else if (*pos == '\\') out[i++] = '\\';
            else out[i++] = *pos;
        } else {
            out[i++] = *pos;
        }
        pos++;
    }
    out[i] = '\0';
    return (int)i;
}

int af_json_get_int(const char* json, const char* key, int* out) {
    char pattern[128];
    sprintf_s(pattern, sizeof(pattern), "\"%s\"", key);

    const char* pos = strstr(json, pattern);
    if (!pos) return -1;

    pos += strlen(pattern);
    while (*pos && (*pos == ' ' || *pos == ':' || *pos == '\t')) pos++;

    *out = atoi(pos);
    return 0;
}

// ══════════════════════════════════════════════════════
//  HTTP Client (WinHTTP)
// ══════════════════════════════════════════════════════

int af_http_request(const wchar_t* method, const wchar_t* path,
                    const char* body, DWORD body_len,
                    char** out_response, DWORD* out_response_len) {
    HINTERNET session = NULL, connect = NULL, request = NULL;
    DWORD flags = 0;
    int ret = AF_ERR_NETWORK;

    *out_response = NULL;
    *out_response_len = 0;

    session = WinHttpOpen(L"Luaction/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                          WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) goto cleanup;

    connect = WinHttpConnect(session, AF_SERVER_HOST, AF_SERVER_PORT, 0);
    if (!connect) goto cleanup;

#if AF_USE_HTTPS
    flags = WINHTTP_FLAG_SECURE;
#endif

    request = WinHttpOpenRequest(connect, method, path, NULL,
                                 WINHTTP_NO_REFERER,
                                 WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request) goto cleanup;

    // Set content-type header
    WinHttpAddRequestHeaders(request,
        L"Content-Type: application/json\r\n",
        (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);

    // Send request
    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            (LPVOID)body, body_len, body_len, 0)) {
        goto cleanup;
    }

    if (!WinHttpReceiveResponse(request, NULL)) {
        goto cleanup;
    }

    // Read response
    DWORD total_read = 0;
    DWORD alloc_size = 4096;
    char* buffer = (char*)malloc(alloc_size);
    if (!buffer) goto cleanup;

    DWORD bytes_available, bytes_read;
    while (WinHttpQueryDataAvailable(request, &bytes_available) && bytes_available > 0) {
        if (total_read + bytes_available + 1 > alloc_size) {
            alloc_size = (total_read + bytes_available + 1) * 2;
            if (alloc_size > AF_MAX_RESPONSE) {
                free(buffer);
                goto cleanup;
            }
            char* new_buf = (char*)realloc(buffer, alloc_size);
            if (!new_buf) { free(buffer); goto cleanup; }
            buffer = new_buf;
        }

        if (!WinHttpReadData(request, buffer + total_read, bytes_available, &bytes_read)) {
            free(buffer);
            goto cleanup;
        }
        total_read += bytes_read;
    }

    buffer[total_read] = '\0';
    *out_response = buffer;
    *out_response_len = total_read;
    ret = AF_OK;

cleanup:
    if (request) WinHttpCloseHandle(request);
    if (connect) WinHttpCloseHandle(connect);
    if (session) WinHttpCloseHandle(session);
    return ret;
}

// ══════════════════════════════════════════════════════
//  Authentication
// ══════════════════════════════════════════════════════

int af_authenticate(const char* license_key, AF_AuthResponse* response) {
    memset(response, 0, sizeof(AF_AuthResponse));
    response->data = NULL;

    // Generate HWID
    char hwid[128];
    if (af_generate_hwid(hwid, sizeof(hwid)) != AF_OK) {
        strcpy_s(response->error, sizeof(response->error), "Failed to generate HWID");
        return AF_ERR_HWID;
    }

    // Build JSON body
    char body[512];
    sprintf_s(body, sizeof(body),
              "{\"key\":\"%s\",\"hwid\":\"%s\",\"version\":\"%s\"}",
              license_key, hwid, AF_VERSION);

    // Send request
    char* resp_body = NULL;
    DWORD resp_len = 0;
    int ret = af_http_request(L"POST", L"/api/auth",
                               body, (DWORD)strlen(body),
                               &resp_body, &resp_len);
    if (ret != AF_OK || !resp_body) {
        strcpy_s(response->error, sizeof(response->error), "Connection failed");
        return AF_ERR_NETWORK;
    }

    // Check for error response
    char error_code[64] = {0};
    if (af_json_get_string(resp_body, "error", error_code, sizeof(error_code)) == 0
        && error_code[0] != '\0') {
        // Map error codes
        af_json_get_string(resp_body, "message", response->error, sizeof(response->error));
        free(resp_body);

        if (strcmp(error_code, "HWID_MISMATCH") == 0)    return AF_ERR_HWID_LOCKED;
        if (strcmp(error_code, "KEY_EXPIRED") == 0)       return AF_ERR_EXPIRED;
        if (strcmp(error_code, "PROJECT_KILLED") == 0)    return AF_ERR_KILLED;
        if (strcmp(error_code, "KEY_BLACKLISTED") == 0)   return AF_ERR_BLACKLISTED;
        return AF_ERR_AUTH;
    }

    // Parse success response
    if (af_json_get_string(resp_body, "nonce", response->nonce, sizeof(response->nonce)) < 0 ||
        af_json_get_string(resp_body, "version", response->server_version, sizeof(response->server_version)) < 0) {
        free(resp_body);
        strcpy_s(response->error, sizeof(response->error), "Invalid server response");
        return AF_ERR_PARSE;
    }

    af_json_get_string(resp_body, "version_hash", response->version_hash, sizeof(response->version_hash));

    // Parse nested payload object: { iv, tag, data }
    // Find "payload" object in response
    const char* payload_start = strstr(resp_body, "\"payload\"");
    if (!payload_start) {
        free(resp_body);
        strcpy_s(response->error, sizeof(response->error), "No payload in response");
        return AF_ERR_PARSE;
    }

    af_json_get_string(payload_start, "iv", response->iv, sizeof(response->iv));
    af_json_get_string(payload_start, "tag", response->tag, sizeof(response->tag));

    // The data field can be very large, allocate dynamically
    // Find "data":"..." within payload
    const char* data_key = strstr(payload_start, "\"data\"");
    if (!data_key) {
        free(resp_body);
        strcpy_s(response->error, sizeof(response->error), "No data in payload");
        return AF_ERR_PARSE;
    }

    data_key += 6; // skip "data"
    while (*data_key && (*data_key == ' ' || *data_key == ':' || *data_key == '\t')) data_key++;
    if (*data_key != '"') {
        free(resp_body);
        return AF_ERR_PARSE;
    }
    data_key++; // skip opening quote

    const char* data_end = strchr(data_key, '"');
    if (!data_end) {
        free(resp_body);
        return AF_ERR_PARSE;
    }

    DWORD data_hex_len = (DWORD)(data_end - data_key);
    response->data = (char*)malloc(data_hex_len + 1);
    if (!response->data) {
        free(resp_body);
        return AF_ERR_PARSE;
    }
    memcpy(response->data, data_key, data_hex_len);
    response->data[data_hex_len] = '\0';
    response->data_len = data_hex_len;

    response->status = AF_OK;
    free(resp_body);
    return AF_OK;
}

// ══════════════════════════════════════════════════════
//  Decrypt Payload
// ══════════════════════════════════════════════════════

static int af_decrypt_payload(const char* hwid, AF_AuthResponse* auth_resp,
                              AF_DecryptedPayload* out) {
    memset(out, 0, sizeof(AF_DecryptedPayload));

    // We need the master_key to derive the decryption key
    // In real deployment, the master_key would be embedded (obfuscated) in the binary
    // For this implementation, we derive using the same HKDF as the server

    // Decode hex fields
    BYTE iv[12], tag[16];
    int iv_len = af_hex_decode(auth_resp->iv, iv, sizeof(iv));
    int tag_len = af_hex_decode(auth_resp->tag, tag, sizeof(tag));
    if (iv_len < 0 || tag_len < 0) return AF_ERR_DECRYPT;

    BYTE nonce_bytes[32];
    int nonce_len = af_hex_decode(auth_resp->nonce, nonce_bytes, sizeof(nonce_bytes));
    if (nonce_len < 0) return AF_ERR_DECRYPT;

    // Decode ciphertext
    DWORD ct_hex_len = auth_resp->data_len;
    DWORD ct_len = ct_hex_len / 2;
    BYTE* ciphertext = (BYTE*)malloc(ct_len);
    if (!ciphertext) return AF_ERR_DECRYPT;
    if (af_hex_decode(auth_resp->data, ciphertext, ct_len) < 0) {
        free(ciphertext);
        return AF_ERR_DECRYPT;
    }

    // HWID hash (salt for HKDF)
    BYTE hwid_hash[32];
    af_sha256((const BYTE*)hwid, (DWORD)strlen(hwid), hwid_hash);

    // For the client to derive the same key, it needs the master_key
    // This would be embedded in the binary in production
    // Here we show the derivation structure — in real use you'd
    // hardcode or retrieve the master key securely
    // For demo, we'll attempt decryption with a placeholder
    // In production: the key exchange would use a different mechanism
    // (e.g., ECDH or the master key baked into the binary at build time)

    // Placeholder: derive key (in production, master_key comes from build config)
    printf("[*] Payload received (%d bytes encrypted)\n", ct_len);
    printf("[*] To decrypt, the master_key must be embedded in the binary\n");
    printf("[*] Nonce: %.32s...\n", auth_resp->nonce);

    free(ciphertext);
    return AF_OK;
}

// ══════════════════════════════════════════════════════
//  Cleanup
// ══════════════════════════════════════════════════════

void af_free_response(AF_AuthResponse* resp) {
    if (resp->data) {
        SecureZeroMemory(resp->data, resp->data_len);
        free(resp->data);
        resp->data = NULL;
    }
}

void af_free_payload(AF_DecryptedPayload* payload) {
    if (payload->script) {
        SecureZeroMemory(payload->script, payload->script_len);
        free(payload->script);
        payload->script = NULL;
    }
}

// ══════════════════════════════════════════════════════
//  Main Entry Point
// ══════════════════════════════════════════════════════

int main(int argc, char* argv[]) {
    printf("\n");
    printf("  ╔══════════════════════════════════════╗\n");
    printf("  ║  Luaction Loader  v%s      ║\n", AF_VERSION);
    printf("  ╚══════════════════════════════════════╝\n\n");

    // Get license key from arg or prompt
    char license_key[64] = {0};

    if (argc > 1) {
        strncpy_s(license_key, sizeof(license_key), argv[1], _TRUNCATE);
    } else {
        printf("  Key: ");
        fflush(stdout);
        if (!fgets(license_key, sizeof(license_key), stdin)) {
            printf("  [!] Failed to read key\n");
            return 1;
        }
        // Strip newline
        size_t len = strlen(license_key);
        if (len > 0 && license_key[len - 1] == '\n') license_key[len - 1] = '\0';
        if (len > 1 && license_key[len - 2] == '\r') license_key[len - 2] = '\0';
    }

    if (strlen(license_key) == 0) {
        printf("  [!] No license key provided\n");
        return 1;
    }

    // Generate and display HWID
    char hwid[128];
    printf("  [*] Generating HWID...\n");
    if (af_generate_hwid(hwid, sizeof(hwid)) != AF_OK) {
        printf("  [!] Failed to generate hardware ID\n");
        return 1;
    }
    printf("  [+] HWID: %.16s...\n", hwid);

    // Authenticate
    printf("  [*] Authenticating...\n");
    AF_AuthResponse auth_resp;
    int result = af_authenticate(license_key, &auth_resp);

    if (result != AF_OK) {
        printf("  [!] Authentication failed: %s\n", auth_resp.error);
        printf("  [!] Error code: %d\n", result);
        af_free_response(&auth_resp);
        printf("\n  Press Enter to exit...");
        getchar();
        return 1;
    }

    printf("  [+] Authenticated successfully!\n");
    printf("  [+] Server version: %s\n", auth_resp.server_version);
    printf("  [+] Payload size: %lu bytes\n", auth_resp.data_len / 2);

    // In production: decrypt and execute the script payload
    // af_decrypt_payload(hwid, &auth_resp, &payload);

    af_free_response(&auth_resp);

    printf("  [+] Done.\n\n");
    printf("  Press Enter to exit...");
    getchar();
    return 0;
}

