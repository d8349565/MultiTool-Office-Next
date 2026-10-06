param([string]$CustomVersion, [switch]$KeepVersion)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectDir = Split-Path -Parent $PSScriptRoot
if ($KeepVersion -and $CustomVersion) { throw '-KeepVersion 与 -CustomVersion 不能同时使用。' }
$pkgPath = Join-Path $projectDir 'package.json'
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($KeepVersion) { $CustomVersion = $pkg.version }
elseif (-not $CustomVersion) {
    $now = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time')
    $major = $now.Year
    $minor = [int]$now.ToString('MMdd')
    $patch = [int]$now.ToString('HHmm')
    $old = $pkg.version.Split('.')
    # 同一分钟内重打包或系统时间回拨时仍递增，避免生成无法区分的发布包。
    if ($old.Count -eq 3 -and $old[0] -eq "$major" -and $old[1] -eq "$minor") { $patch = [Math]::Max($patch, [int]$old[2] + 1) }
    $CustomVersion = "$major.$minor.$patch"
}
if ($CustomVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or @($CustomVersion.Split('.') | Where-Object { $_.Length -gt 5 -or [int]$_ -gt 65535 }).Count -gt 0) {
    throw '版本号须为三个不超过 65535 的非负整数，不能有前导零，例如 2026.1001.2033。'
}
$contents = @{}
$pkgText = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8
$contents['package.json'] = ([regex]::new('"version"\s*:\s*"[^"]+"')).Replace($pkgText, '"version": "' + $CustomVersion + '"', 1)
# Windows PowerShell 5.1 无法解析锁文件的空字符串键，交给 Node 处理根项目版本。
$lockUpdated = & node (Join-Path $PSScriptRoot 'package-lock-version.mjs') (Join-Path $projectDir 'package-lock.json') $CustomVersion $pkg.name
if ($LASTEXITCODE -ne 0) { throw '前端锁文件校验失败。' }
$contents['package-lock.json'] = ($lockUpdated -join "`n") + "`n"
$tauriText = Get-Content -LiteralPath (Join-Path $projectDir 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8
$null = $tauriText | ConvertFrom-Json
$contents['src-tauri\tauri.conf.json'] = ([regex]::new('"version"\s*:\s*"[^"]+"')).Replace($tauriText, '"version": "' + $CustomVersion + '"', 1)
$cargoText = Get-Content -LiteralPath (Join-Path $projectDir 'src-tauri\Cargo.toml') -Raw -Encoding UTF8
$cargoPattern = '(?ms)(^\[package\]\s*\r?\n(?:(?!^\[).)*?^version\s*=\s*)"[^"]+"'
if (-not [regex]::IsMatch($cargoText, $cargoPattern)) { throw '原生项目清单缺少版本号。' }
$contents['src-tauri\Cargo.toml'] = ([regex]::new($cargoPattern)).Replace($cargoText, '${1}"' + $CustomVersion + '"', 1)
$cargoLock = Get-Content -LiteralPath (Join-Path $projectDir 'src-tauri\Cargo.lock') -Raw -Encoding UTF8
$lockPattern = '(?m)(^name = "office-next"\r?\nversion = )"[^"]+"'
if ([regex]::Matches($cargoLock, $lockPattern).Count -ne 1) { throw '原生锁文件缺少唯一的当前项目条目。' }
$contents['src-tauri\Cargo.lock'] = [regex]::Replace($cargoLock, $lockPattern, '${1}"' + $CustomVersion + '"')
$utf8 = New-Object System.Text.UTF8Encoding($false)
# 先完成所有校验，再写入；其他依赖版本保持原值。
foreach ($file in $contents.Keys) { [System.IO.File]::WriteAllText((Join-Path $projectDir $file), $contents[$file], $utf8) }
Write-Host "应用及两类锁文件版本已同步：$CustomVersion" -ForegroundColor Green
