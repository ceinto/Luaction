@echo off
echo === Building DLL Injector ===
echo.

where cl >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [*] Using MSVC...
    cl /O2 /W4 /Fe:injector.exe injector.c /link advapi32.lib
    cl /O2 /LD /Fe:test_dll.dll test_dll.c /link user32.lib
) else (
    where gcc >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        echo [*] Using GCC...
        gcc -O2 -Wall -o injector.exe injector.c -ladvapi32
        gcc -shared -O2 -o test_dll.dll test_dll.c -luser32
    ) else (
        echo [!] No compiler found. Install MSVC or MinGW.
        exit /b 1
    )
)

echo.
if exist injector.exe if exist test_dll.dll (
    echo [OK] Build complete.
    echo.
    echo Usage:
    echo   injector.exe notepad.exe test_dll.dll
    echo   injector.exe 1234 C:\path\to\your.dll
) else (
    echo [!] Build failed.
)
