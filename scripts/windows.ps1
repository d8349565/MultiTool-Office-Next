param(
    [ValidateSet('desktop','package','build','check')][string]$Action = 'desktop',
    [string]$CustomVersion,
    [switch]$KeepVersion,
    [switch]$ForceOcr,
    [switch]$NoReveal,
    [ValidateSet('auto','msvc','gnu')][string]$Toolchain = 'auto'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'file-hash.ps1')
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectDir = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments, [string]$Failure)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Failure（退出码：$LASTEXITCODE）" }
}

function Get-GnuCompiler {
    foreach ($folder in @('.tools\w64devkit\bin', '.tools\mingw64\bin')) {
        $directory = Join-Path $projectDir $folder
        $compiler = Join-Path $directory 'gcc.exe'
        if ((Test-Path -LiteralPath $compiler) -and (Test-Path -LiteralPath (Join-Path $directory 'windres.exe'))) {
            return @{ Directory = $directory; Compiler = $compiler }
        }
    }
    $gcc = Get-Command gcc -ErrorAction SilentlyContinue
    $windres = Get-Command windres -ErrorAction SilentlyContinue
    if ($gcc -and $windres) { return @{ Directory = Split-Path -Parent $gcc.Source; Compiler = $gcc.Source } }
}

function Select-PackageToolchain {
    $vswhere = if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe' }
    $visualStudio = if ($vswhere -and (Test-Path -LiteralPath $vswhere)) { & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
    $hasMsvc = $visualStudio -or (Get-Command link.exe -ErrorAction SilentlyContinue)
    if ($Toolchain -eq 'msvc' -or ($Toolchain -eq 'auto' -and $hasMsvc)) {
        if (-not $hasMsvc) { throw '指定了微软工具链，但未找到 C++ 链接器。可使用自动模式，或安装微软 C++ 构建工具与 Windows SDK。' }
        $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
        $rustInfo = & rustc -vV
        if ($LASTEXITCODE -eq 0 -and $rustInfo -contains 'host: x86_64-pc-windows-msvc') {
            Write-Host '构建工具链：微软 MSVC（64 位）' -ForegroundColor Cyan
            return
        }
        if ($Toolchain -eq 'msvc') { throw '微软 Rust 工具链不可用，请安装 stable-x86_64-pc-windows-msvc。' }
    }
    $gnu = Get-GnuCompiler
    if (-not $gnu) { throw '没有找到可用的 Windows 构建环境。请安装微软 C++ 构建工具，或提供 GNU 编译器及资源编译器（gcc、windres）。' }
    $env:PATH = $gnu.Directory + ';' + $env:PATH
    $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
    $rustInfo = & rustc -vV
    if ($LASTEXITCODE -ne 0 -or $rustInfo -notcontains 'host: x86_64-pc-windows-gnu') { throw 'GNU Rust 工具链不可用，请安装 stable-x86_64-pc-windows-gnu。' }
    $gccPath = $gnu.Compiler
    $machine = & $gccPath -dumpmachine
    if ($LASTEXITCODE -ne 0 -or $machine -notmatch '^x86_64-w64-mingw32$') { throw 'GNU 编译器必须支持 64 位 Windows，不能混用其他目标架构。' }
    Write-Host '构建工具链：GNU / MinGW（64 位，兼容既有打包环境）' -ForegroundColor Cyan
}
function Invoke-Package {
    if ($KeepVersion -and $CustomVersion) { throw '-KeepVersion 与 -CustomVersion 不能同时使用。' }
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host '开始构建 Windows 安装包' -ForegroundColor Cyan
    Write-Host '[1/5] 检查环境与安装配置' -ForegroundColor Yellow
    foreach ($command in @('node', 'npm.cmd', 'cargo', 'rustc')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "缺少构建工具：$command，请先安装项目要求的开发环境。" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules\.bin\tauri.cmd'))) { throw '前端构建依赖尚未安装，请先执行 npm ci。' }
    Select-PackageToolchain
    Invoke-Checked 'node' @('scripts/check-installer.mjs') '安装配置检查失败'

    Write-Host '[2/5] 检查或构建离线文字识别组件' -ForegroundColor Yellow
    $ocrArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-ocr.ps1'))
    if ($ForceOcr) { $ocrArgs += '-Force' }
    Invoke-Checked 'powershell.exe' $ocrArgs '离线文字识别组件构建失败'

    Write-Host '[3/5] 同步应用与锁文件版本' -ForegroundColor Yellow
    $versionFiles = @('package.json', 'package-lock.json', 'src-tauri\tauri.conf.json', 'src-tauri\Cargo.toml', 'src-tauri\Cargo.lock')
    $snapshots = @{}
    foreach ($file in $versionFiles) { $snapshots[$file] = [System.IO.File]::ReadAllBytes((Join-Path $projectDir $file)) }
    try {
        $versionArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'sync-version.ps1'))
        if ($KeepVersion) { $versionArgs += '-KeepVersion' }
        elseif ($CustomVersion) { $versionArgs += @('-CustomVersion', $CustomVersion) }
        Invoke-Checked 'powershell.exe' $versionArgs '版本同步失败'
        $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        $version = $config.version
        $bundleDir = Join-Path $projectDir 'src-tauri\target\release\bundle\nsis'
        $installer = Join-Path $bundleDir "$($config.productName)_${version}_x64-setup.exe"
        $previousWrite = if (Test-Path -LiteralPath $installer) { (Get-Item -LiteralPath $installer).LastWriteTimeUtc.Ticks } else { 0 }
        Write-Host '[4/5] 编译应用并生成安装包（前端只编译一次）' -ForegroundColor Yellow
        $buildStarted = [DateTime]::UtcNow
        Invoke-Checked (Join-Path $projectDir 'node_modules\.bin\tauri.cmd') @('build', '--bundles', 'nsis', '--', '--locked') '安装包构建失败，请检查上方编译日志及选中的工具链'

        Write-Host '[5/5] 核验本次安装包' -ForegroundColor Yellow
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "本次版本的安装包未生成：$installer" }
        $result = Get-Item -LiteralPath $installer
        if ($result.Length -eq 0 -or $result.LastWriteTimeUtc -lt $buildStarted -or $result.LastWriteTimeUtc.Ticks -eq $previousWrite) { throw '安装包为空或未在本次构建中更新，不能将旧产物报告为成功。' }
        $hash = (Get-FileSha256 $installer)
        $report = [ordered]@{ version = $version; toolchain = $env:RUSTUP_TOOLCHAIN; installer = $installer; bytes = $result.Length; sha256 = $hash; builtAt = $result.LastWriteTimeUtc.ToString('o') }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText("$installer.sha256", "$hash  $($result.Name)`n", $utf8)
        [System.IO.File]::WriteAllText("$installer.json", ($report | ConvertTo-Json) + "`n", $utf8)
    } catch {
        # 失败时恢复发布前版本；依赖使用锁文件构建。
        foreach ($file in $versionFiles) { [System.IO.File]::WriteAllBytes((Join-Path $projectDir $file), $snapshots[$file]) }
        throw
    }
    Write-Host "安装包已生成：$installer" -ForegroundColor Green
    Write-Host "版本：$version；大小：$([Math]::Round($result.Length / 1MB, 2)) MiB；耗时：$([Math]::Round($timer.Elapsed.TotalSeconds, 1)) 秒"
    Write-Host "SHA-256：$hash"
    if (-not $NoReveal) {
        try { Start-Process explorer.exe -ArgumentList "/select,`"$installer`"" }
        catch { Write-Warning "安装包已生成，但无法打开资源管理器：$($_.Exception.Message)" }
    }
}

$previousToolchain = $env:RUSTUP_TOOLCHAIN
$previousPath = $env:PATH
$previousCargoHome = $env:CARGO_HOME
$previousRustupHome = $env:RUSTUP_HOME
Push-Location -LiteralPath $projectDir
try {
    $portableRust = Join-Path $projectDir '.tools\cargo\bin'
    if (Test-Path -LiteralPath (Join-Path $portableRust 'cargo.exe')) {
        $env:CARGO_HOME = Join-Path $projectDir '.tools\cargo'
        $env:RUSTUP_HOME = Join-Path $projectDir '.tools\rustup'
        $env:PATH = $portableRust + ';' + $env:PATH
    }
    if ($Action -ne 'package') {
        $gnu = Get-GnuCompiler
        if ($gnu) { $env:PATH = $gnu.Directory + ';' + $env:PATH; $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu' }
    }
    switch ($Action) {
        'desktop' { Invoke-Checked 'npm.cmd' @('run', 'desktop') '桌面开发启动失败' }
        'package' { Invoke-Package }
        'build' { Invoke-Checked 'cargo' @('build', '--release', '--manifest-path', 'src-tauri/Cargo.toml') '应用编译失败' }
        'check' { Invoke-Checked 'cargo' @('check', '--manifest-path', 'src-tauri/Cargo.toml') '静态检查失败' }
    }
    $exitCode = 0
} catch {
    [Console]::Error.WriteLine("操作失败：$($_.Exception.Message)")
    $exitCode = 1
} finally {
    Pop-Location
    $env:RUSTUP_TOOLCHAIN = $previousToolchain
    $env:PATH = $previousPath
    $env:CARGO_HOME = $previousCargoHome
    $env:RUSTUP_HOME = $previousRustupHome
}
exit $exitCode
