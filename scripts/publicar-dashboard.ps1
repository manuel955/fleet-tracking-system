param(
  [string]$Servidor = '86.48.19.189'
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $raiz 'dashboard'
$clave = Join-Path $env:USERPROFILE '.ssh\pos_contabo_ed25519'
$archivo = Join-Path $env:TEMP "fleet-dashboard-$PID.tar.gz"
$destinoRemoto = '/opt/fleet-dashboard'
$stagingRemoto = '/opt/fleet-dashboard.stage'
$unidadRemota = '/etc/systemd/system/fleet-dashboard.service'
$unidadContenido = @"
[Unit]
Description=Fleet Tracking dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$destinoRemoto
ExecStart=/usr/bin/python3 -m http.server 8081 --bind 0.0.0.0 --directory $destinoRemoto
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

try {
  # El dashboard es estatico: se envia solo su carpeta, sin reiniciar Docker
  # ni ningun servicio de Sistema POS.
  & tar.exe -czf $archivo -C $dashboard .
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar el dashboard.' }

  & scp -i $clave $archivo "root@${Servidor}:/tmp/fleet-dashboard.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el dashboard al VPS.' }

  $comandoRemoto = @(
    'set -e',
    "rm -rf $stagingRemoto",
    "mkdir -p $stagingRemoto $destinoRemoto",
    "tar -xzf /tmp/fleet-dashboard.tar.gz -C $stagingRemoto",
    'rm -f /tmp/fleet-dashboard.tar.gz',
    "rsync -a --delete $stagingRemoto/ $destinoRemoto/",
    "rm -rf $stagingRemoto",
    "test -f $destinoRemoto/index.html",
    "echo $unidadBase64 | base64 -d > $unidadRemota",
    'systemctl daemon-reload',
    'systemctl enable --now fleet-dashboard.service',
    'systemctl restart fleet-dashboard.service',
    'ufw allow 8081/tcp comment ''Fleet Tracking dashboard''',
    'curl -fsS http://127.0.0.1:8081/ >/dev/null'
  ) -join '; '

  & ssh -i $clave -o BatchMode=yes -o ConnectTimeout=15 "root@$Servidor" $comandoRemoto
  if ($LASTEXITCODE -ne 0) { throw 'El VPS no pudo publicar o verificar el dashboard.' }

  Write-Host "Dashboard publicado: http://${Servidor}:8081/" -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $archivo) {
    Remove-Item -LiteralPath $archivo -Force
  }
}
