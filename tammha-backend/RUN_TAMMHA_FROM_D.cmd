@echo off
setlocal
rem Run Tammha local security verification using D: for npm cache and temp files.
rem This wrapper does not run database migrations or contact Supabase directly.
set "BASE=%~dp0"
set "PROJECT=%BASE%tammha-backend"
if not exist "%PROJECT%\RUN_SECURITY_FIXES.cmd" set "PROJECT=%BASE%"
if not exist "%PROJECT%RUN_SECURITY_FIXES.cmd" if not exist "%PROJECT%\RUN_SECURITY_FIXES.cmd" (
    echo ERROR: Cannot find RUN_SECURITY_FIXES.cmd.
    echo Save this file in D:\Tammha, next to the extracted tammha-backend folder.
    pause
    exit /b 1
)
set "npm_config_cache=%BASE%npm-cache"
set "TEMP=%BASE%temp"
set "TMP=%BASE%temp"
if not exist "%npm_config_cache%" mkdir "%npm_config_cache%"
if not exist "%TEMP%" mkdir "%TEMP%"
echo Running Tammha checks from: %PROJECT%
echo npm cache: %npm_config_cache%
echo Temp files: %TEMP%
echo No Supabase database migration will be run.
cd /d "%PROJECT%"
call "%PROJECT%\RUN_SECURITY_FIXES.cmd"
set "RESULT=%ERRORLEVEL%"
echo.
echo Report location: %PROJECT%\security-results.txt
echo Exit code: %RESULT%
pause
exit /b %RESULT%
