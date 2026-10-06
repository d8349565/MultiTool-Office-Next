$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectDir 'src-tauri\target\debug\office-next.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw '请先构建原生调试版，再运行单实例检查。'
}
if (Get-Process -Name 'office-next' -ErrorAction SilentlyContinue) {
    throw '已有工作台进程运行；为避免影响正在进行的任务，本次检查未启动。'
}
$identifier = (Get-Content -LiteralPath (Join-Path $projectDir 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).identifier
$existing = $null
if ([System.Threading.Mutex]::TryOpenExisting($identifier + '-sim', [ref]$existing)) {
    $existing.Dispose()
    throw '已有工作台实例驻留；本次检查未启动。'
}
$dataDir = Join-Path $projectDir ('test-workspace\single-instance-' + [guid]::NewGuid().ToString('N'))
$previousDataDir = $env:OFFICE_NEXT_TEST_DATA_DIR
$previousHidden = $env:OFFICE_NEXT_TEST_WINDOW_HIDDEN
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Start-TestInstance {
    $process = Start-Process -FilePath $executable -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
    $processes.Add($process)
    return $process
}
function Wait-TestCondition {
    param([scriptblock]$Condition, [string]$Failure)
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 100
    }
    throw $Failure
}
try {
    $env:OFFICE_NEXT_TEST_DATA_DIR = $dataDir
    $env:OFFICE_NEXT_TEST_WINDOW_HIDDEN = '1'
    $first = Start-TestInstance
    Wait-TestCondition {
        if ($first.HasExited) { throw '首次启动失败。' }
        Test-Path -LiteralPath (Join-Path $dataDir 'office.sqlite')
    } '首次启动未完成。'
    if ($first.WaitForExit(2000)) { throw '首个实例意外退出。' }
    $first.Refresh()
    if ($first.MainWindowTitle -eq 'MultiTool Office') { throw '测试实例未保持后台隐藏状态。' }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $duplicate = Start-TestInstance
        if (-not $duplicate.WaitForExit(10000) -or $duplicate.ExitCode -ne 0) {
            throw '重复启动没有正常退出，可能生成了第二个实例。'
        }
        if ($first.HasExited) { throw '重复启动导致原实例退出。' }
    }
    $first.Refresh()
    Write-Output ('重复启动后原进程的窗口标题：' + $first.MainWindowTitle)
    Wait-TestCondition {
        $first.Refresh()
        $first.MainWindowTitle -eq 'MultiTool Office'
    } '重复启动没有唤回原实例的主窗口。'
    Write-Output '通过：连续三次重复启动均退出，原实例仍存活，后台主窗口被唤回。'
    Stop-Process -Id $first.Id
    if (-not $first.WaitForExit(5000)) { throw '测试实例没有停止。' }
    $restarted = Start-TestInstance
    if ($restarted.WaitForExit(3000)) { throw '退出后重新启动被错误拦截。' }
    Write-Output '通过：退出后可以正常重新启动。'
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
            $null = $process.WaitForExit(5000)
        }
        $process.Dispose()
    }
    $env:OFFICE_NEXT_TEST_DATA_DIR = $previousDataDir
    $env:OFFICE_NEXT_TEST_WINDOW_HIDDEN = $previousHidden
}
