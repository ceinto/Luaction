#pragma once
#ifndef ANTIFOLD_LOADER_H
#define ANTIFOLD_LOADER_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>
#include <intrin.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "advapi32.lib")

// ── Configuration ────────────────────────────────────
#define AF_SERVER_HOST   L"localhost"
#define AF_SERVER_PORT   3000
#define AF_USE_HTTPS     0           // 0 for dev, 1 for production
#define AF_VERSION       "1.0.0"
#define AF_MAX_RESPONSE  (1024*1024) // 1MB max response

// ── Status codes ─────────────────────────────────────
#define AF_OK               0
#define AF_ERR_HWID         1
#define AF_ERR_NETWORK      2
#define AF_ERR_AUTH          3
#define AF_ERR_DECRYPT      4
#define AF_ERR_VERSION      5
#define AF_ERR_KILLED       6
#define AF_ERR_EXPIRED      7
#define AF_ERR_HWID_LOCKED  8
#define AF_ERR_BLACKLISTED  9
#define AF_ERR_PARSE        10

// ── Structures ───────────────────────────────────────

typedef struct {
    char key[64];
    char hwid[128];
    char version[16];
} AF_AuthRequest;

typedef struct {
    int  status;
    char nonce[64];
    char iv[64];
    char tag[64];
    char* data;         // heap-allocated encrypted payload
    DWORD data_len;
    char server_version[16];
    char version_hash[64];
    char error[128];
} AF_AuthResponse;

typedef struct {
    char* script;       // heap-allocated decrypted script
    DWORD script_len;
} AF_DecryptedPayload;

// ── Function declarations ────────────────────────────

// HWID generation: disk serial + CPU ID + machine name → SHA256
int  af_generate_hwid(char* out_hwid, DWORD out_size);

// HTTP request to API
int  af_http_request(const wchar_t* method, const wchar_t* path,
                     const char* body, DWORD body_len,
                     char** out_response, DWORD* out_response_len);

// Authentication
int  af_authenticate(const char* license_key, AF_AuthResponse* response);

// Version check
int  af_check_version(const char* project_id, char* out_version, char* out_hash);

// Crypto
int  af_sha256(const BYTE* data, DWORD data_len, BYTE* out_hash);
int  af_hkdf_derive(const BYTE* master_key, DWORD mk_len,
                    const BYTE* hwid_hash, const BYTE* nonce, DWORD nonce_len,
                    BYTE* out_key, DWORD key_len);
int  af_aes_gcm_decrypt(const BYTE* key, DWORD key_len,
                        const BYTE* iv, DWORD iv_len,
                        const BYTE* tag, DWORD tag_len,
                        const BYTE* ciphertext, DWORD ct_len,
                        BYTE* plaintext, DWORD* pt_len);

// Hex utilities
int  af_hex_decode(const char* hex, BYTE* out, DWORD out_size);
void af_hex_encode(const BYTE* data, DWORD data_len, char* out);

// JSON parsing (minimal, no dependencies)
int  af_json_get_string(const char* json, const char* key, char* out, DWORD out_size);
int  af_json_get_int(const char* json, const char* key, int* out);

// Cleanup
void af_free_response(AF_AuthResponse* resp);
void af_free_payload(AF_DecryptedPayload* payload);

#endif // ANTIFOLD_LOADER_H
