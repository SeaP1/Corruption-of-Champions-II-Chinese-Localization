param()
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Runtime = Join-Path $ScriptDir 'cn_runtime'
$TranslatedApp = Join-Path $ScriptDir 'translated_app'
$RuntimeApp = Join-Path $Runtime 'resources\app'
$GameExe = Join-Path $Runtime 'CoC II.exe'
$Log = Join-Path $ScriptDir 'launch_cn.log'

function Write-Log($msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'CoC II.exe'))) {
    throw 'Cannot find CoC II.exe in game root: ' + $Root
  }
  if (-not (Test-Path -LiteralPath $TranslatedApp)) {
    throw 'Cannot find translator\translated_app. Run: node ./translator/apply_translations_to_app.mjs'
  }

  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

  Write-Log 'Sync base game files to cn_runtime...'
  $baseArgs = @(
    $Root,
    $Runtime,
    '/E','/COPY:DAT','/DCOPY:DAT','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP',
    '/XD', (Join-Path $Root 'translator'),
    '/XF', 'COC2 CN.exe', '*.zip'
  )
  & robocopy @baseArgs | Out-Null
  if ($LASTEXITCODE -gt 7) { throw 'robocopy base failed with exit code ' + $LASTEXITCODE }

  Write-Log 'Overlay translated app files...'
  New-Item -ItemType Directory -Force -Path $RuntimeApp | Out-Null
  $overlayArgs = @(
    $TranslatedApp,
    $RuntimeApp,
    '/E','/COPY:DAT','/DCOPY:DAT','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP'
  )
  & robocopy @overlayArgs | Out-Null
  if ($LASTEXITCODE -gt 7) { throw 'robocopy translated_app failed with exit code ' + $LASTEXITCODE }

  if (-not (Test-Path -LiteralPath $GameExe)) {
    throw 'Cannot find runtime exe after sync: ' + $GameExe
  }

  Write-Log 'Launch CN runtime.'
  Start-Process -FilePath $GameExe -WorkingDirectory $Runtime
} catch {
  Write-Log ('ERROR: ' + $_.Exception.Message)
  Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
  [System.Windows.MessageBox]::Show($_.Exception.Message, 'COC2 CN launcher error') | Out-Null
  exit 1
}
