@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publicar-dashboard.ps1"
if errorlevel 1 (
  echo.
  echo La publicacion fallo.
) else (
  echo.
  echo La publicacion termino correctamente.
)
pause
