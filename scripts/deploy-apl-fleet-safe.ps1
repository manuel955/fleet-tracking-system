param(
  [string]$Servidor = '86.48.19.189'
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$fuente = Join-Path $raiz 'vps-backend'
$clave = Join-Path $env:USERPROFILE '.ssh\pos_contabo_ed25519'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$archivo = Join-Path $env:TEMP "apl-fleet-full-$stamp.tar.gz"
$archivoRemoto = "/tmp/apl-fleet-full-$stamp.tar.gz"
$destinoRemoto = '/opt/apl-fleet-vps'
$respaldoRemoto = "/opt/apl-fleet-vps.backup.$stamp"

if (-not (Test-Path -LiteralPath $fuente)) {
  throw "No existe el backend APL: $fuente"
}
if (-not (Test-Path -LiteralPath $clave)) {
  throw "No existe la llave SSH: $clave"
}
if ($destinoRemoto -ne '/opt/apl-fleet-vps') {
  throw 'Destino remoto no permitido.'
}

try {
  & tar.exe -czf $archivo --exclude=node_modules --exclude=.env -C $fuente .
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar el backend APL.' }

  & scp.exe -i $clave -o BatchMode=yes -o ConnectTimeout=15 $archivo "root@${Servidor}:$archivoRemoto"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el backend APL.' }

  $publicar = @(
    'set -e',
    "test '$destinoRemoto' = '/opt/apl-fleet-vps'",
    "test -d '$destinoRemoto'",
    "cd '$destinoRemoto'",
    "bash '$destinoRemoto/deploy/backup-postgres.sh'",
    "cp -a '$destinoRemoto' '$respaldoRemoto'",
    "tar -xzf '$archivoRemoto' -C '$destinoRemoto'",
    "cd '$destinoRemoto'",
    'docker compose --env-file .env config --quiet',
    'docker compose --env-file .env up -d --build --no-deps api',
    'healthy=0',
    'for i in 1 2 3 4 5 6 7 8 9 10; do sleep 3; if curl -fsS http://127.0.0.1:8080/health >/tmp/apl-health.json; then healthy=1; break; fi; done',
    "if [ `"`$healthy`" -ne 1 ]; then cp -a '$respaldoRemoto/.' '$destinoRemoto/'; cd '$destinoRemoto'; docker compose --env-file .env up -d --build --no-deps api; exit 1; fi",
    'cat /tmp/apl-health.json',
    'echo',
    "rm -f '$archivoRemoto'"
  ) -join '; '

  & ssh.exe -i $clave -o BatchMode=yes -o ConnectTimeout=15 "root@$Servidor" $publicar
  if ($LASTEXITCODE -ne 0) {
    throw 'El API APL no pasó la verificación; se solicitó la reversión automática.'
  }

  Write-Host "API APL publicado. Respaldo: $respaldoRemoto" -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $archivo) {
    Remove-Item -LiteralPath $archivo -Force
  }
}
