"""Render Office files with an installed local engine, using disposable copies."""
import base64
from collections import OrderedDict
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET


class RenderUnavailable(Exception):
    pass


# Paths are JSON on stdin, never interpolated into executable PowerShell code.
# A job owns only newly created conversion processes; a timeout closes the job
# and cannot close an Office window that the user already had open.
POWERSHELL = r'''
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PreviewJob {
    [StructLayout(LayoutKind.Sequential)] public struct Basic {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Limits {
        public Basic Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref Limits l, uint s);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j, uint c);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint p);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
    public static uint Pid(long window) { uint p; GetWindowThreadProcessId(new IntPtr(window), out p); return p; }
    public static IntPtr Create() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Limits limits = new Limits(); limits.Basic.Flags = 0x2000;
        if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
            if (job != IntPtr.Zero) CloseHandle(job);
            throw new Exception("Cannot isolate preview process");
        }
        return job;
    }
    public static void Attach(IntPtr job, uint pid) {
        IntPtr process = OpenProcess(0x101, false, pid);
        try { if (process == IntPtr.Zero || !AssignProcessToJobObject(job, process)) throw new Exception("Cannot isolate preview engine"); }
        finally { if (process != IntPtr.Zero) CloseHandle(process); }
    }
    public static void WatchParent(IntPtr job, int pid) {
        var parent = System.Diagnostics.Process.GetProcessById(pid);
        var watcher = new System.Threading.Thread(() => {
            try { parent.WaitForExit(); TerminateJobObject(job, 1); }
            finally { System.Diagnostics.Process.GetCurrentProcess().Kill(); }
        });
        watcher.IsBackground = true; watcher.Start();
    }
}
'@
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$job = [PreviewJob]::Create()
[PreviewJob]::WatchParent($job, [int]$inputData.parent)
$result = ''
$busy = $false
try {
    $isWord = [IO.Path]::GetExtension($inputData.source) -eq '.docx'
    $progIds = if ($isWord) { @('Word.Application', 'kwps.Application') } else { @('PowerPoint.Application', 'kwpp.Application', 'wpp.Application') }
    foreach ($progId in $progIds) {
        if (-not [type]::GetTypeFromProgID($progId)) { continue }
        $app = $null; $document = $null; $owned = $false; $oldOptions = $null
        $existing = @(Get-Process | Select-Object -ExpandProperty Id)
        try {
            $app = New-Object -ComObject $progId
            $appPid = [PreviewJob]::Pid([long]$app.HWND)
            if (-not $appPid) {
                # Hidden Word has no HWND until its first document is open.
                $processName = switch ($progId) { 'Word.Application' { 'WINWORD' } 'PowerPoint.Application' { 'POWERPNT' } 'kwps.Application' { 'wps' } default { 'wpp' } }
                $created = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $existing })
                if ($created.Count -eq 1) { $appPid = [uint32]$created[0].Id }
            }
            if (-not $appPid -or $appPid -in $existing) { $busy = $true; continue }
            $owned = $true
            [PreviewJob]::Attach($job, $appPid)
            $app.AutomationSecurity = 3
            if ($isWord) {
                $app.Visible = $false; $app.DisplayAlerts = 0
                $options = $app.Options
                $oldOptions = @($options.UpdateLinksAtOpen, $options.UpdateFieldsAtPrint, $options.UpdateLinksAtPrint, $options.SaveNormalPrompt)
                $options.UpdateLinksAtOpen = $false; $options.UpdateFieldsAtPrint = $false
                $options.UpdateLinksAtPrint = $false; $options.SaveNormalPrompt = $false
                $missing = [Type]::Missing
                $openArgs = [object[]]@([string]$inputData.source, $false, $true, $false, $missing, $missing, $false, $missing, $missing, $missing, $missing, $false, $false, $missing, $true, $missing)
                $document = $app.Documents.GetType().InvokeMember('Open', [Reflection.BindingFlags]::InvokeMethod, $null, $app.Documents, $openArgs)
                $document.ExportAsFixedFormat($inputData.output, 17, $false)
            } else {
                $app.DisplayAlerts = 1
                $document = $app.Presentations.Open($inputData.source, -1, 0, 0)
                # Include hidden slides so PDF page indices match the source.
                # This changes only the in-memory disposable copy.
                foreach ($slide in $document.Slides) { $slide.SlideShowTransition.Hidden = 0 }
                $document.PrintOptions.PrintHiddenSlides = -1
                $document.PrintOptions.Ranges.ClearAll()
                $range = $document.PrintOptions.Ranges.Add(1, $document.Slides.Count)
                $document.ExportAsFixedFormat($inputData.output, 2, 1, 0, 1, 1, -1, $range, 4)
                $document.Saved = -1
            }
            if (Test-Path -LiteralPath $inputData.output) { $result = $progId; break }
        } catch {
            if (Test-Path -LiteralPath $inputData.output) { Remove-Item -LiteralPath $inputData.output -Force }
        } finally {
            if ($document) { try { if ($isWord) { $document.Close(0) } else { $document.Close() } } catch {} }
            if ($owned -and $app) {
                if ($oldOptions) { try {
                    $options.UpdateLinksAtOpen = $oldOptions[0]; $options.UpdateFieldsAtPrint = $oldOptions[1]
                    $options.UpdateLinksAtPrint = $oldOptions[2]; $options.SaveNormalPrompt = $oldOptions[3]
                } catch {} }
                try { $app.Quit() } catch {}
            }
            if ($document) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
            if ($app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
        }
    }
    if (-not $result -and $inputData.libreoffice) {
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $inputData.libreoffice; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $profile = ([Uri]$inputData.profile).AbsoluteUri
        $filter = if ($isWord) { 'pdf:writer_pdf_Export' } else { 'pdf:impress_pdf_Export:{\"ExportHiddenSlides\":{\"type\":\"boolean\",\"value\":\"true\"}}' }
        $start.Arguments = '-env:UserInstallation="' + $profile + '" --headless --nologo --nodefault --norestore --convert-to "' + $filter + '" --outdir "' + [IO.Path]::GetDirectoryName($inputData.output) + '" "' + $inputData.source + '"'
        $process = [Diagnostics.Process]::Start($start)
        [PreviewJob]::Attach($job, [uint32]$process.Id)
        $process.WaitForExit()
        if ($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $inputData.output)) { $result = 'LibreOffice' }
    }
    if ($result) { [Console]::Out.WriteLine($result) }
    elseif ($busy) { [Console]::Out.WriteLine('busy') }
} finally { [void][PreviewJob]::CloseHandle($job) }
'''


def safe_copy(path, destination):
    """Do not open active content or external resources in a full Office engine."""
    from file_preview import MAX_FILE, xml_part

    # Inspect the exact bytes that the engine will open, even if the source is
    # being edited concurrently. All copies live in our disposable directory.
    shutil.copyfile(path, destination)
    path = destination
    if path.suffix.lower() == ".ppt":
        import olefile
        from ppt_text import records
        with olefile.OleFileIO(str(path)) as document:
            if any(any(part.lower() in {"vba", "macros", "objectpool"} for part in name) for name in document.listdir()):
                raise RenderUnavailable("含宏或嵌入对象的旧版 PPT 使用文字预览")
            with document.openstream("PowerPoint Document") as stream:
                data = stream.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise RenderUnavailable("旧版 PPT 内部数据超过原样预览限制")
        def inspect(start, end, depth=0):
            if depth > 32:
                raise RenderUnavailable("旧版 PPT 内部结构过深")
            for flags, kind, body, stop in records(data, start, end):
                if kind == 0x0409:  # MS-PPT ExObjList: external/embedded objects.
                    if any(child_kind != 0x040A for _, child_kind, _, _ in records(data, body, stop)):
                        raise RenderUnavailable("含外部资源或嵌入对象的旧版 PPT 使用文字预览")
                if flags & 15 == 15:
                    inspect(body, stop, depth + 1)
        inspect(0, len(data))
    else:
        with zipfile.ZipFile(path) as archive:
            parts = archive.infolist()
            if len(parts) > 4096 or sum(part.file_size for part in parts) > 128 * 1024 * 1024:
                raise RenderUnavailable("文档内部数据超过原样预览限制")
            for part in parts:
                name = part.filename.lower()
                if any(value in name for value in ("vbaproject", "activex/", "embeddings/")):
                    raise RenderUnavailable("含活动内容或嵌入对象的文档使用文字预览")
                if not name.endswith((".xml", ".rels")):
                    continue
                root = xml_part(archive, part.filename)
                instructions = []
                for node in root.iter():
                    if name.endswith(".rels") and node.get("TargetMode", "").lower() == "external" and not node.get("Type", "").endswith("/hyperlink"):
                        raise RenderUnavailable("文档含外部图片、模板或链接数据，已使用文字预览")
                    tag = node.tag.rsplit("}", 1)[-1]
                    if tag in {"altChunk", "oleObject", "OLEObject", "control", "dataSource"}:
                        raise RenderUnavailable("文档含活动内容，已使用文字预览")
                    if tag == "instrText":
                        instructions.append(node.text or "")
                    if tag == "fldChar":
                        instructions.append(" ")
                    instructions.extend(" " + v + " " for k, v in node.attrib.items() if k.endswith("}instr"))
                if re.search(r"\b(?:DDE(?:AUTO)?|INCLUDETEXT|INCLUDEPICTURE|LINK|DATABASE)\b", "".join(instructions), re.I):
                    raise RenderUnavailable("文档含外部字段，已使用文字预览")


def libreoffice_path():
    for command in ("soffice.com", "soffice.exe"):
        executable = shutil.which(command)
        if executable:
            return executable
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        candidate = Path(os.environ.get(variable, "C:/Program Files")) / "LibreOffice/program/soffice.com"
        if candidate.is_file():
            return str(candidate)
    return ""


def convert(source, output, profile):
    if os.name != "nt":
        raise RenderUnavailable("原样预览需要本机安装 Office、WPS 或 LibreOffice")
    profile.mkdir()
    # A fresh profile has no trusted macro locations or extensions.
    (profile / "user").mkdir()
    (profile / "user/registrymodifications.xcu").write_text(
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>', encoding="utf-8")
    command = base64.b64encode(POWERSHELL.encode("utf-16-le")).decode("ascii")
    import json
    try:
        result = subprocess.run(
            [str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
             "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", command],
            input=json.dumps(dict(source=str(source), output=str(output), profile=str(profile), libreoffice=libreoffice_path(), parent=os.getpid())),
            encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW, timeout=22, check=False)
    except subprocess.TimeoutExpired as error:
        raise RenderUnavailable("本机排版渲染超时，已使用文字预览") from error
    if result.stdout.strip() == "busy":
        raise RenderUnavailable("本机排版引擎正在使用，已使用文字预览；关闭对应 Office/WPS 窗口后可重试")
    if result.returncode or not output.is_file() or not output.stat().st_size:
        raise RenderUnavailable("原样预览需要可用的 Office、WPS 或 LibreOffice；当前已使用文字预览")


# The worker is serial. Cache PDFs in memory, bounded to three files / 64 MB.
# Disposable source copies and PDFs are removed immediately after conversion.
_cache = OrderedDict()


def rendered_preview(path, page, images):
    from file_preview import image_preview

    stat = path.stat()
    key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    now = time.monotonic()
    for old_key, (_, accessed) in list(_cache.items()):
        if now - accessed > 120 or old_key[0] == key[0] and old_key != key:
            _cache.pop(old_key)
    if key in _cache:
        pdf, _ = _cache.pop(key)
    else:
        try:
            with tempfile.TemporaryDirectory(prefix="office-layout-") as directory:
                source = Path(directory) / ("preview" + path.suffix.lower())
                output = Path(directory) / "preview.pdf"
                safe_copy(path, source)
                convert(source, output, Path(directory) / "profile")
                if output.stat().st_size > 32 * 1024 * 1024:
                    raise RenderUnavailable("排版结果超过 32 MB，已使用文字预览")
                pdf = output.read_bytes()
            current = path.stat()
            if (current.st_size, current.st_mtime_ns, current.st_ctime_ns) != key[1:]:
                raise RenderUnavailable("文件在预览期间发生变化，请重新预览")
        except (OSError, ValueError, zipfile.BadZipFile, KeyError, ET.ParseError) as error:
            raise RenderUnavailable("本机排版渲染暂不可用，已使用文字预览") from error
    while len(_cache) >= 3 or sum(len(value[0]) for value in _cache.values()) + len(pdf) > 64 * 1024 * 1024:
        _cache.popitem(last=False)
    _cache[key] = (pdf, now)
    result = image_preview(pdf, page, images)
    result["notice"] = "本机原样预览 · 保留分页、图片与排版；不播放动画。"
    return result
