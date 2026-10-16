@echo off
setlocal
set "DEEPCODE_STANDALONE=1"
set "DEEPCODE_AUTO_SHUTDOWN=1"

set "CLI_DIR=%~dp0.."
if "%1"=="--dev" shift

echo [*] Init...
echo [+] bun run --cwd "%CLI_DIR%" src\index.ts %*

bun run --cwd "%CLI_DIR%" "%CLI_DIR%\src\index.ts" %*
exit /b %ERRORLEVEL%
