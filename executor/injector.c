/*
 * Generic DLL Injector
 * Method: CreateRemoteThread + LoadLibraryA
 * Features: arch detection, PE validation, process listing
 * Usage:  injector.exe <process_name|PID> <dll_path>
 *         injector.exe --list
 *
 * Build: cl /O2 /W4 injector.c /link advapi32.lib
 *    or: gcc -O2 -Wall injector.c -o injector.exe -ladvapi32
 */

#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── helpers ─────────────────────────────────────────────── */

static void print_last_error(const char *context) {
    DWORD err = GetLastError();
    char *msg = NULL;
    FormatMessageA(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
        FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, err, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        (LPSTR)&msg, 0, NULL);
    fprintf(stderr, "[!] %s failed (0x%08lX): %s", context, err, msg ? msg : "unknown\n");
    if (msg) LocalFree(msg);
}

/* ── enable SeDebugPrivilege ─────────────────────────────── */

static BOOL enable_debug_privilege(void) {
    HANDLE hToken;
    TOKEN_PRIVILEGES tp;
    LUID luid;

    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken)) {
        print_last_error("OpenProcessToken");
        return FALSE;
    }

    if (!LookupPrivilegeValueA(NULL, "SeDebugPrivilege", &luid)) {
        print_last_error("LookupPrivilegeValue");
        CloseHandle(hToken);
        return FALSE;
    }

    tp.PrivilegeCount           = 1;
    tp.Privileges[0].Luid       = luid;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

    if (!AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(tp), NULL, NULL)) {
        print_last_error("AdjustTokenPrivileges");
        CloseHandle(hToken);
        return FALSE;
    }

    /* AdjustTokenPrivileges can "succeed" but not grant the privilege */
    if (GetLastError() == ERROR_NOT_ALL_ASSIGNED) {
        fprintf(stderr, "[!] SeDebugPrivilege not held — run as admin\n");
        CloseHandle(hToken);
        return FALSE;
    }

    CloseHandle(hToken);
    printf("[+] SeDebugPrivilege enabled\n");
    return TRUE;
}

/* ── find PID by process name (case-insensitive) ─────────── */

static DWORD find_pid(const char *proc_name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) {
        print_last_error("CreateToolhelp32Snapshot");
        return 0;
    }

    PROCESSENTRY32 pe;
    pe.dwSize = sizeof(pe);
    DWORD pid = 0;

    if (Process32First(snap, &pe)) {
        do {
            if (_stricmp(pe.szExeFile, proc_name) == 0) {
                pid = pe.th32ProcessID;
                break;
            }
        } while (Process32Next(snap, &pe));
    }

    CloseHandle(snap);
    return pid;
}

/* ── list running processes with arch info ────────────────── */

static const char *get_process_arch(DWORD pid) {
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc) return "???";

    BOOL isWow64 = FALSE;
    BOOL queried = IsWow64Process(hProc, &isWow64);
    CloseHandle(hProc);

    if (!queried) return "???";

#ifdef _WIN64
    return isWow64 ? "x86" : "x64";
#else
    /* 32-bit injector can't reliably distinguish — assume x86 */
    (void)isWow64;
    return "x86";
#endif
}

static void list_processes(void) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) {
        print_last_error("CreateToolhelp32Snapshot");
        return;
    }

    PROCESSENTRY32 pe;
    pe.dwSize = sizeof(pe);

    printf("%-8s  %-5s  %s\n", "PID", "ARCH", "PROCESS");
    printf("----------------------------------------------\n");

    if (Process32First(snap, &pe)) {
        do {
            const char *arch = get_process_arch(pe.th32ProcessID);
            printf("%-8lu  %-5s  %s\n", pe.th32ProcessID, arch, pe.szExeFile);
        } while (Process32Next(snap, &pe));
    }

    CloseHandle(snap);
}

/* ── architecture detection ──────────────────────────────── */

typedef enum {
    ARCH_UNKNOWN = 0,
    ARCH_X86,
    ARCH_X64
} arch_t;

static const char *arch_str(arch_t a) {
    switch (a) {
        case ARCH_X86: return "x86";
        case ARCH_X64: return "x64";
        default:       return "unknown";
    }
}

static arch_t get_injector_arch(void) {
#ifdef _WIN64
    return ARCH_X64;
#else
    return ARCH_X86;
#endif
}

static arch_t get_target_arch(HANDLE hProc) {
    BOOL isWow64 = FALSE;
    if (!IsWow64Process(hProc, &isWow64)) {
        print_last_error("IsWow64Process");
        return ARCH_UNKNOWN;
    }
#ifdef _WIN64
    return isWow64 ? ARCH_X86 : ARCH_X64;
#else
    /* running as 32-bit on a 64-bit OS: target is also WoW64 = x86 */
    (void)isWow64;
    return ARCH_X86;
#endif
}

/* read PE header from DLL file to determine its machine type */
static arch_t get_dll_arch(const char *dll_path) {
    HANDLE hFile = CreateFileA(dll_path, GENERIC_READ, FILE_SHARE_READ,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        print_last_error("CreateFile (DLL)");
        return ARCH_UNKNOWN;
    }

    IMAGE_DOS_HEADER dos;
    DWORD bytesRead = 0;

    if (!ReadFile(hFile, &dos, sizeof(dos), &bytesRead, NULL) ||
        bytesRead != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE) {
        fprintf(stderr, "[!] Invalid DOS header in DLL\n");
        CloseHandle(hFile);
        return ARCH_UNKNOWN;
    }

    /* seek to PE header */
    if (SetFilePointer(hFile, dos.e_lfanew, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER) {
        print_last_error("SetFilePointer");
        CloseHandle(hFile);
        return ARCH_UNKNOWN;
    }

    DWORD pe_sig = 0;
    if (!ReadFile(hFile, &pe_sig, sizeof(pe_sig), &bytesRead, NULL) ||
        bytesRead != sizeof(pe_sig) || pe_sig != IMAGE_NT_SIGNATURE) {
        fprintf(stderr, "[!] Invalid PE signature in DLL\n");
        CloseHandle(hFile);
        return ARCH_UNKNOWN;
    }

    IMAGE_FILE_HEADER fileHdr;
    if (!ReadFile(hFile, &fileHdr, sizeof(fileHdr), &bytesRead, NULL) ||
        bytesRead != sizeof(fileHdr)) {
        fprintf(stderr, "[!] Failed to read IMAGE_FILE_HEADER\n");
        CloseHandle(hFile);
        return ARCH_UNKNOWN;
    }

    CloseHandle(hFile);

    switch (fileHdr.Machine) {
        case IMAGE_FILE_MACHINE_I386:  return ARCH_X86;
        case IMAGE_FILE_MACHINE_AMD64: return ARCH_X64;
        default:
            fprintf(stderr, "[!] Unknown PE machine type: 0x%04X\n", fileHdr.Machine);
            return ARCH_UNKNOWN;
    }
}

/* ── resolve full DLL path ───────────────────────────────── */

static BOOL resolve_dll_path(const char *input, char *out, DWORD out_sz) {
    DWORD len = GetFullPathNameA(input, out_sz, out, NULL);
    if (len == 0 || len >= out_sz) {
        print_last_error("GetFullPathName");
        return FALSE;
    }
    if (GetFileAttributesA(out) == INVALID_FILE_ATTRIBUTES) {
        fprintf(stderr, "[!] DLL not found: %s\n", out);
        return FALSE;
    }
    return TRUE;
}

/* ── core injection ──────────────────────────────────────── */

typedef enum {
    INJ_OK = 0,
    INJ_ERR_OPEN_PROCESS,
    INJ_ERR_ARCH_MISMATCH,
    INJ_ERR_ALLOC,
    INJ_ERR_WRITE,
    INJ_ERR_THREAD,
    INJ_ERR_TIMEOUT
} inj_result_t;

static const char *inj_result_str[] = {
    "success",
    "OpenProcess failed",
    "architecture mismatch",
    "VirtualAllocEx failed",
    "WriteProcessMemory failed",
    "CreateRemoteThread failed",
    "remote thread timed out"
};

static inj_result_t inject_dll(DWORD pid, const char *dll_path) {
    inj_result_t result = INJ_OK;
    HANDLE hProc   = NULL;
    void  *remote  = NULL;
    HANDLE hThread = NULL;

    size_t path_len = strlen(dll_path) + 1;

    /* open target */
    hProc = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
        PROCESS_VM_OPERATION  | PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE, pid);
    if (!hProc) {
        print_last_error("OpenProcess");
        return INJ_ERR_OPEN_PROCESS;
    }
    printf("[+] Opened process PID %lu (handle 0x%p)\n", pid, hProc);

    /* ── architecture validation ── */
    arch_t injArch    = get_injector_arch();
    arch_t targetArch = get_target_arch(hProc);
    arch_t dllArch    = get_dll_arch(dll_path);

    printf("[*] Injector arch : %s\n", arch_str(injArch));
    printf("[*] Target arch   : %s\n", arch_str(targetArch));
    printf("[*] DLL arch      : %s\n", arch_str(dllArch));

    if (targetArch != ARCH_UNKNOWN && dllArch != ARCH_UNKNOWN &&
        targetArch != dllArch) {
        fprintf(stderr, "[!] ABORT: DLL is %s but target process is %s\n",
                arch_str(dllArch), arch_str(targetArch));
        CloseHandle(hProc);
        return INJ_ERR_ARCH_MISMATCH;
    }
    if (injArch != ARCH_UNKNOWN && targetArch != ARCH_UNKNOWN &&
        injArch != targetArch) {
        fprintf(stderr, "[!] ABORT: Injector is %s but target process is %s\n",
                arch_str(injArch), arch_str(targetArch));
        fprintf(stderr, "    Use the %s build of the injector.\n",
                arch_str(targetArch));
        CloseHandle(hProc);
        return INJ_ERR_ARCH_MISMATCH;
    }
    printf("[+] Architecture check passed\n");

    /* allocate memory in target for DLL path string */
    remote = VirtualAllocEx(hProc, NULL, path_len,
                            MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        print_last_error("VirtualAllocEx");
        result = INJ_ERR_ALLOC;
        goto cleanup;
    }
    printf("[+] Allocated %zu bytes at 0x%p in target\n", path_len, remote);

    /* write DLL path into target */
    SIZE_T written = 0;
    if (!WriteProcessMemory(hProc, remote, dll_path, path_len, &written) ||
        written != path_len) {
        print_last_error("WriteProcessMemory");
        result = INJ_ERR_WRITE;
        goto cleanup;
    }
    printf("[+] Wrote DLL path to target memory\n");

    /* resolve LoadLibraryA in kernel32 (same VA across processes) */
    FARPROC pLoadLib = GetProcAddress(GetModuleHandleA("kernel32.dll"), "LoadLibraryA");
    if (!pLoadLib) {
        print_last_error("GetProcAddress(LoadLibraryA)");
        result = INJ_ERR_THREAD;
        goto cleanup;
    }

    /* create remote thread calling LoadLibraryA(dll_path) */
    DWORD threadId = 0;
    hThread = CreateRemoteThread(hProc, NULL, 0,
                                 (LPTHREAD_START_ROUTINE)pLoadLib,
                                 remote, 0, &threadId);
    if (!hThread) {
        print_last_error("CreateRemoteThread");
        result = INJ_ERR_THREAD;
        goto cleanup;
    }
    printf("[+] Remote thread created (TID %lu), waiting...\n", threadId);

    /* wait for LoadLibrary to finish */
    DWORD wait = WaitForSingleObject(hThread, 10000);
    if (wait == WAIT_TIMEOUT) {
        fprintf(stderr, "[!] Remote thread timed out (10s)\n");
        result = INJ_ERR_TIMEOUT;
        goto cleanup;
    }

    /* check return value — LoadLibrary returns HMODULE (non-zero = success) */
    DWORD exitCode = 0;
    GetExitCodeThread(hThread, &exitCode);
    if (exitCode == 0) {
        fprintf(stderr, "[!] LoadLibraryA returned NULL in target — DLL load failed\n");
        fprintf(stderr, "    Check: correct architecture (x86 vs x64)?\n");
        fprintf(stderr, "    Check: DLL dependencies satisfied?\n");
    } else {
        printf("[+] DLL loaded at 0x%08lX in target process\n", exitCode);
    }

cleanup:
    if (hThread) CloseHandle(hThread);
    if (remote)  VirtualFreeEx(hProc, remote, 0, MEM_RELEASE);
    if (hProc)   CloseHandle(hProc);
    return result;
}

/* ── main ────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    printf("=== Generic DLL Injector ===\n");
    printf("    Method: CreateRemoteThread + LoadLibraryA\n");
    printf("    Arch:   %s\n\n",
#ifdef _WIN64
           "x64"
#else
           "x86"
#endif
    );

    /* --list mode: show all running processes */
    if (argc == 2 && (_stricmp(argv[1], "--list") == 0 ||
                      _stricmp(argv[1], "-l") == 0)) {
        enable_debug_privilege();
        list_processes();
        return 0;
    }

    /* --check mode: validate DLL arch without injecting */
    if (argc == 3 && (_stricmp(argv[1], "--check") == 0 ||
                      _stricmp(argv[1], "-c") == 0)) {
        arch_t dllArch = get_dll_arch(argv[2]);
        printf("[*] DLL architecture: %s\n", arch_str(dllArch));
        return (dllArch == ARCH_UNKNOWN) ? 1 : 0;
    }

    if (argc != 3) {
        printf("Usage:\n");
        printf("  %s <process_name | PID> <dll_path>   Inject DLL\n", argv[0]);
        printf("  %s --list                            List processes\n", argv[0]);
        printf("  %s --check <dll_path>                Check DLL arch\n\n", argv[0]);
        printf("Examples:\n");
        printf("  %s notepad.exe payload.dll\n", argv[0]);
        printf("  %s 1234 C:\\path\\to\\hook.dll\n", argv[0]);
        printf("  %s --list\n", argv[0]);
        printf("  %s --check payload.dll\n", argv[0]);
        return 1;
    }

    /* enable debug priv (best effort — not fatal if it fails) */
    enable_debug_privilege();

    /* resolve target PID */
    DWORD pid = 0;
    char *endptr = NULL;
    unsigned long raw = strtoul(argv[1], &endptr, 10);

    if (*endptr == '\0' && raw > 0) {
        /* argument is numeric — treat as PID */
        pid = (DWORD)raw;
        printf("[*] Target PID: %lu\n", pid);
    } else {
        /* argument is a process name */
        printf("[*] Searching for process: %s\n", argv[1]);
        pid = find_pid(argv[1]);
        if (pid == 0) {
            fprintf(stderr, "[!] Process '%s' not found\n", argv[1]);
            return 1;
        }
        printf("[+] Found PID: %lu\n", pid);
    }

    /* resolve DLL path */
    char dll_full[MAX_PATH];
    if (!resolve_dll_path(argv[2], dll_full, MAX_PATH)) {
        return 1;
    }
    printf("[*] DLL path: %s\n", dll_full);

    /* inject */
    inj_result_t res = inject_dll(pid, dll_full);
    if (res != INJ_OK) {
        fprintf(stderr, "\n[FAIL] Injection failed: %s\n", inj_result_str[res]);
        return 1;
    }

    printf("\n[OK] Injection successful\n");
    return 0;
}
