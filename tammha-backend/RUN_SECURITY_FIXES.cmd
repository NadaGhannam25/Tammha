@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo Tammha - One-run security update and tests
 echo ==========================================
echo This runs npm install, the full verify suite, and a production audit.
echo It NEVER runs database migrations or modifies Supabase.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-security-fix.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (echo RESULT: REVIEW REQUIRED. See security-results.txt) else (echo RESULT: All verification checks passed. Check security-results.txt for remaining advisories.)
echo.
pause
exit /b %CODE%
