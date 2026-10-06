param([string]$Python = $env:OFFICE_OCR_PYTHON, [switch]$Force, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'file-hash.ps1')
$project = Split-Path -Parent $PSScriptRoot
$built = Join-Path $project 'src-tauri\binaries\ocr-worker'
$manifestPath = Join-Path $project '.tools\ocr-build-manifest.json'
$inputs = @((Get-ChildItem -LiteralPath (Join-Path $project 'ocr-worker') -File -Recurse | Where-Object { $_.Extension -in @('.py', '.spec') -or $_.Name -eq 'requirements.txt' }).FullName) + $PSCommandPath + (Join-Path $PSScriptRoot 'file-hash.ps1')
$fingerprint = ($inputs | Sort-Object | ForEach-Object { $_.Substring($project.Length + 1).Replace('\', '/') + ':' + (Get-FileSha256 $_) }) -join "`n"

function Get-OutputFiles {
    @(Get-ChildItem -LiteralPath $built -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($built.Length + 1); bytes = $_.Length; sha256 = (Get-FileSha256 $_.FullName) }
    })
}

$canReuse = $false
if (-not $Force -and (Test-Path -LiteralPath $manifestPath) -and (Test-Path -LiteralPath (Join-Path $built 'ocr-worker.exe'))) {
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.inputs -eq $fingerprint) {
            $actual = @(Get-OutputFiles)
            $canReuse = $actual.Count -gt 1 -and $actual.Count -eq $manifest.files.Count
            for ($i = 0; $canReuse -and $i -lt $actual.Count; $i++) {
                $canReuse = $actual[$i].path -eq $manifest.files[$i].path -and $actual[$i].bytes -eq $manifest.files[$i].bytes -and $actual[$i].sha256 -eq $manifest.files[$i].sha256
            }
        }
    } catch { Write-Warning '文字识别缓存清单无效，将重新构建。' }
}
if ($canReuse) { Write-Host '文字识别源码、依赖声明和完整产物校验一致，复用缓存。' -ForegroundColor Green; return }
if ($CheckOnly) { throw '文字识别缓存缺失、过期或损坏，需要重新构建。' }
$venv = Join-Path $project '.tools\ocr-venv'
$runtime = Join-Path $venv 'Scripts\python.exe'

function Get-CompatiblePython {
    param([string]$Command, [string[]]$Arguments = @())
    try {
        $info = & $Command @Arguments -c 'import sys, struct; print(sys.version_info.major, sys.version_info.minor, struct.calcsize(chr(80)) * 8, sep=chr(58)); print(sys.executable)' 2>$null
        if ($LASTEXITCODE -eq 0 -and $info.Count -eq 2 -and $info[0] -eq '3:12:64') { return $info[1] }
    } catch { }
}

$runtimeCompatible = if (Test-Path -LiteralPath $runtime) { Get-CompatiblePython $runtime }
if (-not $runtimeCompatible) {
    if ($Python) {
        $selectedPython = Get-CompatiblePython $Python
        if (-not $selectedPython) { throw "指定的 Python 不可用或版本不兼容：$Python。OCR 构建需要 Python 3.12（64 位）。" }
    } else {
        $selectedPython = Get-CompatiblePython 'py' @('-3.12')
        if (-not $selectedPython) { $selectedPython = Get-CompatiblePython (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe') }
        if (-not $selectedPython) { $selectedPython = Get-CompatiblePython 'python' }
        if (-not $selectedPython) { $selectedPython = Get-CompatiblePython (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe') }
        if (-not $selectedPython) { throw '未找到 Python 3.12（64 位）。请安装该版本，或通过 OFFICE_OCR_PYTHON 指定其 python.exe 完整路径。现有 OCR 虚拟环境不兼容或已失效。' }
    }
    if (Test-Path -LiteralPath $venv) {
        # 仅删除本项目固定位置的虚拟环境，且先确认兼容解释器可用。
        $resolvedVenv = (Resolve-Path -LiteralPath $venv).Path
        $expectedVenv = [System.IO.Path]::GetFullPath((Join-Path $project '.tools\ocr-venv'))
        if ($resolvedVenv -ne $expectedVenv -or ((Get-Item -LiteralPath $venv).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'OCR 虚拟环境路径异常，无法自动重建。' }
        Write-Host '旧 OCR 虚拟环境不兼容或已失效，使用 Python 3.12（64 位）重建。' -ForegroundColor Yellow
        Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
    }
    $Python = $selectedPython
    Write-Host "OCR 构建解释器：$Python" -ForegroundColor Cyan
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw '无法创建文字识别构建环境，请通过 OFFICE_OCR_PYTHON 指定 Python 3.12 的 64 位解释器。' }
    if (-not (Get-CompatiblePython $runtime)) { throw '新建的 OCR 虚拟环境未通过 Python 3.12（64 位）检查。' }
}
# 清单只在完整构建成功后写入，失败的半成品无法命中缓存。
if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath }
& $runtime -m pip install --disable-pip-version-check -r (Join-Path $project 'ocr-worker\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '文字识别组件依赖安装失败。' }
& $runtime -m PyInstaller --noconfirm --clean --distpath (Join-Path $project 'src-tauri\binaries') --workpath (Join-Path $project '.tools\ocr-build') (Join-Path $project 'ocr-worker\worker.spec')
if ($LASTEXITCODE -ne 0) { throw '文字识别组件打包失败。' }
if (-not (Test-Path -LiteralPath (Join-Path $built 'ocr-worker.exe'))) { throw '文字识别程序未生成。' }
$files = @(Get-OutputFiles)
if ($files.Count -le 1) { throw '文字识别组件缺少运行库和模型文件。' }
$manifest = [ordered]@{ inputs = $fingerprint; files = $files }
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "文字识别组件构建完成：$built" -ForegroundColor Green
