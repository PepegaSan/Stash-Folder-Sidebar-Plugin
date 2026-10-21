# Builds the plugin and copies it into a Stash plugins folder (a junction/symlink is NOT followed by
# Stash's plugin scanner on Windows), then asks Stash to reload its plugins.
#   .\tests\e2e-stash\sync-plugin.ps1 -PluginsDir <stash>\plugins [-StashUrl http://127.0.0.1:9999] [-NoBuild]
param(
  [Parameter(Mandatory = $true)] [string] $PluginsDir,
  [string] $StashUrl = "http://127.0.0.1:9999",
  [switch] $NoBuild
)
$ErrorActionPreference = "Stop"
$project = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $NoBuild) { Push-Location $project; try { node build.mjs | Out-Null } finally { Pop-Location } }
$src = Join-Path $project "dist\pmv-creator"
$dst = Join-Path $PluginsDir "pmv-creator"
# data/ (projects, cache, renders) and assets/media (uploaded music) belong to the installation and are kept
robocopy $src $dst /E /XD data media /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }
New-Item -ItemType Directory -Force (Join-Path $dst "assets\media") | Out-Null
$r = Invoke-RestMethod -Uri "$StashUrl/graphql" -Method Post -ContentType "application/json" -Body '{"query":"mutation { reloadPlugins }"}' -TimeoutSec 30
if ($r.errors) { throw ($r.errors | ConvertTo-Json -Compress) }
"synced to $dst, plugins reloaded"
$global:LASTEXITCODE = 0 # robocopy's "files copied" codes (1-7) are not failures
