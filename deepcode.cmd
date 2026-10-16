@echo off
setlocal
call "%~dp0packages\cli\bin\deepcode.cmd" %*
exit /b %ERRORLEVEL%
