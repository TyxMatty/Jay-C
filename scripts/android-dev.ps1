# Runs Jay-C on a connected Android device or emulator (`tauri android dev`), after reloading PATH
# and the Android variables from the registry (terminals opened before installing the SDK lack them).
# A phone on a PC with more than one network (a VPN too): pass the PC's address on the phone's
# network, e.g. `scripts/android-dev.ps1 --host 192.168.1.50`; otherwise Tauri may pick the VPN's.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($k in 'JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME') {
  $value = [Environment]::GetEnvironmentVariable($k, 'User')
  if ($value) { Set-Item "env:$k" $value }
}
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"
Set-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'frontend')
# npx.cmd, not npx (npx.ps1): splatted into a script, `--host` would bind as a parameter name and be lost.
npx.cmd tauri android dev @args
