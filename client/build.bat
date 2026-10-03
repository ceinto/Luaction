@echo off
echo.
echo   Luaction — Client Loader Build
echo   ══════════════════════════════════════
echo.

:: Try to find MSVC
where cl.exe >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [!] cl.exe not found. Run this from a Developer Command Prompt.
    echo   [!] Or run: "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
    echo.
    pause
    exit /b 1
)

echo   [*] Compiling loader.cpp...
cl.exe /nologo /O2 /W3 /EHsc /Fe:luaction_loader.exe loader.cpp /link /SUBSYSTEM:CONSOLE winhttp.lib bcrypt.lib advapi32.lib

if %ERRORLEVEL% equ 0 (
    echo.
    echo   [+] Build successful: luaction_loader.exe
    :: Clean up intermediate files
    del /Q *.obj 2>nul
    echo   [+] Cleaned up build artifacts
) else (
    echo.
    echo   [!] Build failed
)

echo.
pause

