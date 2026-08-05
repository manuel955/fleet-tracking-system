$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$passengerApp = Join-Path $raiz 'passenger-app'

if (-not $env:MAPBOX_ACCESS_TOKEN) {
  throw 'Define MAPBOX_ACCESS_TOKEN antes de compilar/publicar el web de pasajeros.'
}

Push-Location $passengerApp
try {
  $flutterArgs = @(
    'build',
    'web',
    '--release',
    "--dart-define=MAPBOX_ACCESS_TOKEN=$($env:MAPBOX_ACCESS_TOKEN)"
  )
  if ($env:MAPBOX_STYLE_URI) {
    $flutterArgs += "--dart-define=MAPBOX_STYLE_URI=$($env:MAPBOX_STYLE_URI)"
  }
  & flutter @flutterArgs
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el web de pasajeros.' }
}
finally {
  Pop-Location
}

Push-Location $raiz
try {
  # En Windows, firebase.cmd evita el bloqueo de ejecucion de firebase.ps1.
  & firebase.cmd deploy --only hosting:passenger --project rastreoflota-53052
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo publicar el web de pasajeros en Firebase Hosting.' }
}
finally {
  Pop-Location
}
