param(
  [string]$Servidor = '86.48.19.189',
  [string]$Dominio = ''
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $raiz 'dashboard'
$clave = Join-Path $env:USERPROFILE '.ssh\pos_contabo_ed25519'
$archivo = Join-Path $env:TEMP "fleet-dashboard-$PID.tar.gz"
$destinoRemoto = '/opt/fleet-dashboard'
$stagingRemoto = '/opt/fleet-dashboard.stage'
$caddyRemoto = '/etc/caddy/fleet-dashboard.Caddyfile'
$unidadRemota = '/etc/systemd/system/fleet-dashboard-caddy.service'

if ([string]::IsNullOrWhiteSpace($Dominio)) {
  throw 'Publicacion bloqueada: define un dominio con HTTPS usando -Dominio (por ejemplo dashboard.ejemplo.com). No se permite exponer el dashboard solo por IP/HTTP.'
}

if ($Dominio -match '^[0-9.]+$') {
  throw 'Publicacion bloqueada: un certificado publico requiere un dominio DNS, no una direccion IP.'
}

$caddyContenido = @"
$Dominio {
  root * $destinoRemoto
  try_files {path} /index.html
  encode gzip
  header {
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy no-referrer
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
  }
  file_server
}
"@
$caddyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($caddyContenido))
$unidadContenido = @"
[Unit]
Description=Fleet Tracking dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$destinoRemoto
ExecStart=/usr/bin/env caddy run --environ --config $caddyRemoto --adapter caddyfile
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
"@
$unidadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($unidadContenido))

if (-not (Test-Path -LiteralPath $dashboard)) {
  throw "No se encontro la carpeta del dashboard: $dashboard"
}

if (-not (Test-Path -LiteralPath $clave)) {
  throw "No se encontro la llave SSH de despliegue: $clave"
}

if (-not $env:MAPBOX_ACCESS_TOKEN) {
  throw 'Define MAPBOX_ACCESS_TOKEN antes de publicar el dashboard; no se permite publicar un mapa sin token Mapbox.'
}

try {
  Push-Location $raiz
  try {
    & node .\scripts\inject-mapbox-config.mjs
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar la configuracion runtime de Mapbox.' }
  }
  finally {
    Pop-Location
  }

  # El dashboard es estatico: se envia solo su carpeta, sin reiniciar Docker
  # ni ningun servicio de Sistema POS.
  & tar.exe -czf $archivo -C $dashboard .
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar el dashboard.' }

  & scp -i $clave $archivo "root@${Servidor}:/tmp/fleet-dashboard.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el dashboard al VPS.' }

  $comandoRemoto = @(
    'set -e',
    'command -v caddy >/dev/null',
    "rm -rf $stagingRemoto",
    "mkdir -p $stagingRemoto $destinoRemoto /etc/caddy",
    "tar -xzf /tmp/fleet-dashboard.tar.gz -C $stagingRemoto",
    'rm -f /tmp/fleet-dashboard.tar.gz',
    "rsync -a --delete $stagingRemoto/ $destinoRemoto/",
    "rm -rf $stagingRemoto",
    "test -f $destinoRemoto/index.html",
    "echo $caddyBase64 | base64 -d > $caddyRemoto",
    "echo $unidadBase64 | base64 -d > $unidadRemota",
    "caddy validate --config $caddyRemoto --adapter caddyfile",
    'systemctl disable --now fleet-dashboard.service 2>/dev/null || true',
    'rm -f /etc/systemd/system/fleet-dashboard.service',
    'systemctl daemon-reload',
    'systemctl enable --now fleet-dashboard-caddy.service',
    'systemctl restart fleet-dashboard-caddy.service',
    'ufw allow 80/tcp comment ''Fleet Tracking HTTPS redirect''',
    'ufw allow 443/tcp comment ''Fleet Tracking dashboard HTTPS''',
    "curl -fsS --resolve ${Dominio}:443:127.0.0.1 https://${Dominio}/ >/dev/null"
  ) -join '; '

  & ssh -i $clave -o BatchMode=yes -o ConnectTimeout=15 "root@$Servidor" $comandoRemoto
  if ($LASTEXITCODE -ne 0) { throw 'El VPS no pudo publicar o verificar el dashboard.' }

  Write-Host "Dashboard publicado con HTTPS: https://${Dominio}/" -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $archivo) {
    Remove-Item -LiteralPath $archivo -Force
  }
}
