@echo off
setlocal
cd /d "%~dp0.."
echo.
echo Pegue el token de GitHub cuando Firebase lo solicite.
echo No se guardara en este equipo ni en el repositorio.
echo.
call firebase.cmd functions:secrets:set GITHUB_DISPATCH_TOKEN --project rastreoflota-53052
echo.
if errorlevel 1 (
  echo No se pudo guardar el secreto.
) else (
  echo Secreto guardado correctamente en Firebase.
)
pause
