<#
.SYNOPSIS
  Stop the local simulated full stack. Keeps the mongo data volume by default; -Fresh wipes it.
.EXAMPLE
  ./local-down.ps1
  ./local-down.ps1 -Fresh
#>
param([switch]$Fresh)
# No ErrorActionPreference=Stop: docker writes to stderr, which PS 5.1 would treat as fatal.
$compose = Join-Path $PSScriptRoot 'docker-compose.local.yml'
if ($Fresh) {
  docker compose -f $compose down -v
  Write-Host "OK. Stopped and wiped data volume." -ForegroundColor Green
} else {
  docker compose -f $compose down
  Write-Host "OK. Stopped (data preserved; reused on next up)." -ForegroundColor Green
}
