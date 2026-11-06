param([string]$Source, [string]$Dll)
# Lookout Windows helper loader: compiles helper.cs once (cached as a DLL), then serves stdin.
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Dll)) {
  Add-Type -Path $Source -OutputAssembly $Dll -OutputType Library
}
Add-Type -Path $Dll
[Lookout.Helper]::Run()
