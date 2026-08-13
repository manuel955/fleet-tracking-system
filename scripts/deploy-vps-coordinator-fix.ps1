$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$archive = Join-Path $env:TEMP "apl-api-$stamp.tar.gz"
$remoteArchive = "/tmp/apl-api-$stamp.tar.gz"
$key = Join-Path $env:USERPROFILE '.ssh\pos_contabo_ed25519'
tar.exe -czf $archive -C (Join-Path $root 'vps-backend') src/app.js src/auth.js
scp.exe -i $key -o BatchMode=yes -o ConnectTimeout=15 $archive "root@86.48.19.189:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el API.' }
$remoteCommand = "set -e; cp /opt/apl-fleet-vps/src/app.js /opt/apl-fleet-vps/src/app.js.bak-$stamp; cp /opt/apl-fleet-vps/src/auth.js /opt/apl-fleet-vps/src/auth.js.bak-$stamp; tar -xzf $remoteArchive -C /opt/apl-fleet-vps; rm -f $remoteArchive; cd /opt/apl-fleet-vps; docker compose up -d --build --no-deps api; sleep 8; curl -fsS http://127.0.0.1:8080/health; echo; docker ps --format '{{.Names}} {{.Status}}' | sort"
ssh.exe -i $key -o BatchMode=yes -o ConnectTimeout=15 root@86.48.19.189 $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'El API no pasó la verificación remota.' }
Remove-Item -LiteralPath $archive -Force
