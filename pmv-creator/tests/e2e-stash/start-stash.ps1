# Starts an isolated Stash instance for testing the plugin: own config, database and port, so an
# existing Stash installation on this machine is never touched. Media comes from -Library.
#   .\tests\e2e-stash\start-stash.ps1 -StashExe E:\Stash\stash-win.exe -Library C:\Videos\Test [-Root <dir>] [-Port 9977]
# Afterwards: .\tests\e2e-stash\sync-plugin.ps1 -PluginsDir <Root>\plugins -StashUrl http://127.0.0.1:<Port>
param(
  [Parameter(Mandatory = $true)] [string] $StashExe,
  [Parameter(Mandatory = $true)] [string] $Library,
  [string] $Root = (Join-Path $env:TEMP "pmv-creator-stash-test"),
  [int] $Port = 9977
)
$ErrorActionPreference = "Stop"
foreach ($d in "generated", "cache", "blobs", "plugins", "scrapers", "renders") { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
$fp = (Get-Command ffprobe -ErrorAction SilentlyContinue).Source
$cfg = Join-Path $Root "config.yml"
if (-not (Test-Path $cfg)) {
  @"
stash:
  - path: $Library
  - path: $(Join-Path $Root "renders")
database: $(Join-Path $Root "stash-go.sqlite")
generated: $(Join-Path $Root "generated")
cache: $(Join-Path $Root "cache")
blobs_path: $(Join-Path $Root "blobs")
blobs_storage: FILESYSTEM
plugins_path: $(Join-Path $Root "plugins")
scrapers_path: $(Join-Path $Root "scrapers")
$(if ($ff) { "ffmpeg_path: $ff" })
$(if ($fp) { "ffprobe_path: $fp" })
$(if ($py) { "python_path: $py" })
host: 127.0.0.1
port: $Port
nobrowser: true
log_level: Info
video_file_naming_algorithm: OSHASH
calculate_md5: false
"@ | Out-File -Encoding utf8 -NoNewline $cfg
  "wrote $cfg"
}
"starting Stash on http://127.0.0.1:$Port (Ctrl+C stops it) – renders folder is a library, so 'scan after render' works"
& $StashExe -c $cfg --nobrowser
