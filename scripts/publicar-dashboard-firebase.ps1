param(
  [string]$Proyecto = 'rastreoflota-53052'
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $raiz 'dashboard'

if (-not (Test-Path -LiteralPath (Join-Path $dashboard 'index.html'))) {
  throw "No se encontro el dashboard: $dashboard"
}

if (-not $env:MAPBOX_ACCESS_TOKEN) {
  throw 'Define MAPBOX_ACCESS_TOKEN antes de publicar el dashboard.'
}

Push-Location $raiz
try {
  & node .\scripts\inject-mapbox-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar la configuracion runtime de Mapbox.' }

  & firebase.cmd deploy --only hosting:dashboard --project $Proyecto
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo publicar el dashboard en Firebase Hosting.' }

  Write-Host 'Dashboard seguro publicado en: https://rastreoflota-53052-dashboard.web.app/' -ForegroundColor Green
}
finally {
  Pop-Location
}
