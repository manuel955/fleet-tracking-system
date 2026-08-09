param(
  [string]$Servidor = '86.48.19.189',
  [int]$Puerto = 8081
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $raiz 'dashboard'
$clave = Join-Path $env:USERPROFILE '.ssh\pos_contabo_ed25519'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$archivo = Join-Path $env:TEMP "fleet-dashboard-test-$stamp.tar.gz"
$archivoRemoto = "/tmp/fleet-dashboard-test-$stamp.tar.gz"
$stagingRemoto = "/opt/fleet-dashboard.stage.$stamp"
$destinoRemoto = '/opt/fleet-dashboard'

if (-not (Test-Path -LiteralPath $dashboard)) { throw "No se encontro la carpeta: $dashboard" }
if (-not (Test-Path -LiteralPath $clave)) { throw "No se encontro la llave SSH: $clave" }
if (-not (Test-Path -LiteralPath (Join-Path $dashboard 'js\mapbox-runtime-config.generated.js'))) {
  throw 'Falta la configuracion runtime de Mapbox. Ejecuta la inyeccion de configuracion antes de publicar.'
}

try {
  Push-Location $raiz
  try {
    & tar.exe -czf $archivo -C $dashboard .
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar el dashboard.' }
  }
  finally {
    Pop-Location
  }

  & scp.exe -i $clave -o BatchMode=yes -o ConnectTimeout=15 $archivo "root@${Servidor}:$archivoRemoto"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el dashboard al VPS.' }

  $comandoRemoto = @(
    'set -e',
    "mkdir -p $stagingRemoto $destinoRemoto",
    "tar -xzf $archivoRemoto -C $stagingRemoto",
    "cp -a $stagingRemoto/. $destinoRemoto/",
    "test -f $destinoRemoto/index.html",
    'systemctl restart fleet-dashboard.service',
    "curl -fsS http://127.0.0.1:$Puerto/ >/dev/null",
    "unlink $archivoRemoto",
    'echo DASHBOARD_TEST_UPDATED'
  ) -join '; '

  & ssh.exe -i $clave -o BatchMode=yes -o ConnectTimeout=15 "root@$Servidor" $comandoRemoto
  if ($LASTEXITCODE -ne 0) { throw 'El VPS no pudo reiniciar o verificar el dashboard.' }

  Write-Host "Dashboard de prueba actualizado: http://${Servidor}:$Puerto/" -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $archivo) { Remove-Item -LiteralPath $archivo -Force }
}
