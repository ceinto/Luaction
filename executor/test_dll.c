/*
 * Test DLL — pops a MessageBox on attach to prove injection worked.
 * Build: cl /LD test_dll.c /link user32.lib /OUT:test_dll.dll
 *    or: gcc -shared -o test_dll.dll test_dll.c -luser32
 */

#include <windows.h>

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID reserved) {
    (void)reserved;

    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);

        /* quick proof of life — MessageBox from inside the target */
        MessageBoxA(NULL,
                    "DLL injected successfully!\n\n"
                    "This message is running inside the target process.",
                    "Injector Test",
                    MB_OK | MB_ICONINFORMATION);
    }

    return TRUE;
}
