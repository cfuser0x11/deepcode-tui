@echo off
setlocal
set "DEEPCODE_DEAD_MODE=1"
set "DEAD_MODE=1"
call "%~dp0packages\cli\bin\deepcode.cmd" --dead %*
exit /b %ERRORLEVEL%
