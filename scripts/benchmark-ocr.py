"""Windows OCR benchmark. Generate owned PDFs once, then run the ignored native test."""
import argparse
import ctypes as ct
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from ctypes import wintypes as wt


def create_cases(folder):
    from PIL import Image, ImageDraw, ImageFont
    folder.mkdir(parents=True)
    font_path = str(Path(os.environ["WINDIR"]) / "Fonts/msyh.ttc")
    title, body = (ImageFont.truetype(font_path, size) for size in (46, 28))
    for case in range(1, 13):
        pages = []
        for page in (1, 2):
            image = Image.new("RGB", (1240, 1754), "white")
            draw = ImageDraw.Draw(image)
            draw.text((72, 52), "设备巡检与交接记录", font=title, fill="black")
            lines = ["项目名称：设备维修", f"记录编号：WX-{case:03d}    第 {page} 页",
                     "检查范围：仓储、生产和交接区域", "作业内容及复核结果"]
            parts = ["冷却水泵", "电源开关", "传动皮带", "照明装置", "工作台面", "控制面板"]
            actions = ["检查外观并记录状态", "复核安装位置及标识", "清点附件并核对数量", "完成运行检查并签收"]
            for row in range(22):
                lines.append(f"{row+1:02d}    {parts[(case+row+page)%6]}    {actions[(row+page)%4]}    合格")
            lines += ["交接说明：本页各项均已完成现场复核。", "巡检组签收：设备维护班组"]
            for i, line in enumerate(lines):
                draw.text((76, 149+i*52), line, font=body, fill="black")
            pages.append(image)
        pages[0].save(folder / f"sheet-{case:02d}.pdf", save_all=True, append_images=pages[1:], resolution=150)
        for page in pages:
            page.close()
    digests = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.glob("*.pdf"))}
    (folder/"sha256.json").write_text(json.dumps(digests, indent=2))


class Accounting(ct.Structure):
    _fields_ = [(k,ct.c_int64) for k in ("user","kernel","period_user","period_kernel")] + [
        (k,wt.DWORD) for k in ("faults","total","active","terminated")]


class Limits(ct.Structure):
    _fields_ = [("times",ct.c_int64*2),("flags",wt.DWORD),("min",ct.c_size_t),("max",ct.c_size_t),
                ("count",wt.DWORD),("affinity",ct.c_size_t),("priority",wt.DWORD),("scheduling",wt.DWORD)]


class Extended(ct.Structure):
    _fields_ = [("limits",Limits),("io",ct.c_uint64*6),("process_limit",ct.c_size_t),
                ("job_limit",ct.c_size_t),("peak_process",ct.c_size_t),("peak_job",ct.c_size_t)]


kernel = ct.WinDLL("kernel32", use_last_error=True)


def win(name, types, result=wt.BOOL):
    fn = getattr(kernel, name)
    fn.argtypes, fn.restype = types, result
    def checked(*args):
        value = fn(*args)
        if not value:
            raise ct.WinError(ct.get_last_error())
        return value
    return checked


new_job = win("CreateJobObjectW",[ct.c_void_p,wt.LPCWSTR],wt.HANDLE)
assign = win("AssignProcessToJobObject",[wt.HANDLE,wt.HANDLE])
query = win("QueryInformationJobObject",[wt.HANDLE,ct.c_int,ct.c_void_p,wt.DWORD,ct.c_void_p])
set_job = win("SetInformationJobObject",[wt.HANDLE,ct.c_int,ct.c_void_p,wt.DWORD])
close = win("CloseHandle",[wt.HANDLE])
system_times = win("GetSystemTimes",[ct.POINTER(ct.c_uint64)]*3)


def cpu(job):
    accounting = Accounting()
    query(job,1,ct.byref(accounting),ct.sizeof(accounting),None)
    idle, system, user = [ct.c_uint64() for _ in range(3)]
    system_times(ct.byref(idle),ct.byref(system),ct.byref(user))
    return (accounting.user+accounting.kernel)/1e7, idle.value, system.value+user.value


def run(exe, folder, inputs, lanes, split, copies=1, file_count=None):
    folder.mkdir()
    env = {**os.environ,"OCR_BENCH_RUN":"\\\\?\\"+str(folder),"OCR_BENCH_INPUT":str(inputs),"OCR_BENCH_LANES":str(lanes)}
    env.pop("OCR_BENCH_SPLIT",None)
    env["OCR_BENCH_COPIES"]=str(copies)
    expected_files=file_count or 12*copies
    env["OCR_BENCH_FILES"]=str(expected_files)
    if split:
        env["OCR_BENCH_SPLIT"]="1"
    job = new_job(None,None)
    limits = Extended()
    limits.limits.flags = 0x2000  # close the owned process tree on failure
    set_job(job,9,ct.byref(limits),ct.sizeof(limits))
    try:
        log = (folder/"native.log").open("wb")
        proc = subprocess.Popen([exe,"ocr::performance_tests::dense_batch_benchmark","--ignored","--exact","--nocapture"],
                                env=env,stdout=log,stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            assign(job,int(proc._handle))
            deadline=time.monotonic()+900
            while not (folder/"ready").exists():
                if proc.poll() is not None or time.monotonic()>deadline:
                    raise RuntimeError("Benchmark did not initialize")
                time.sleep(.02)
            before = cpu(job)
            (folder/"go").touch()
            while not (folder/"result.json").exists():
                if (proc.poll() is not None and not (folder/"result.json").is_file()) or time.monotonic()>deadline:
                    raise RuntimeError("Benchmark did not finish")
                time.sleep(.05)
            after=cpu(job)
            if proc.wait(timeout=10):
                raise RuntimeError("Native benchmark failed")
            query(job,9,ct.byref(limits),ct.sizeof(limits),None)
        finally:
            log.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    finally:
        close(job)
    data=json.loads((folder/"result.json").read_bytes())
    seconds=data["seconds"]
    summary=dict(lanes=lanes,queueMode="separate serial queues" if split else "one native batch",
                 seconds=round(seconds,2),pagesPerMinute=round(2*expected_files*60/seconds,1),
                 cpuPercent=round(100*(after[0]-before[0])/seconds/os.cpu_count(),1),
                 systemCpuPercent=round(100*(1-(after[1]-before[1])/(after[2]-before[2])),1),
                 peakPrivateMiB=round(limits.peak_job/1048576,1),
                 renamed=sum(f["renamed"] for f in data["files"]),
                 correct=sum(f["field"]=="设备维修" and f["name"]=="设备维修_"+f["original"] for f in data["files"]),
                 lines=sum(f["lines"] for f in data["files"]),pages=sum(f["pages"] for f in data["files"]))
    if data["files"] and all("elapsedMs" in f for f in data["files"]):
        service_seconds=sum(f["elapsedMs"] for f in data["files"])/1000
        summary["meanFileSeconds"]=round(service_seconds/len(data["files"]),3)
        summary["averageActiveFiles"]=round(service_seconds/seconds,3)
    if "workflowSecondsPerQueue" in data:
        summary["workflowSecondsPerQueue"]=data["workflowSecondsPerQueue"]
    if "peakFilesPerQueue" in data:
        summary["peakFilesPerQueue"]=data["peakFilesPerQueue"]
    print(json.dumps(summary),flush=True)
    if summary["renamed"] != expected_files or summary["correct"] != expected_files or summary["pages"] != 2*expected_files:
        raise RuntimeError(f"OCR results changed. See {folder / 'result.json'}")
    return summary


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("directory",type=Path)
    parser.add_argument("--exe",type=Path)
    parser.add_argument("--compare-to",type=Path,help="Old native benchmark executable bound to the old packaged worker")
    parser.add_argument("--baseline","--legacy-split",action="store_true",
                        help="Emulate multiple queues for a legacy serial build. By default both builds run one batch.")
    parser.add_argument("--lanes",type=int,nargs="+",choices=range(9),default=[1,2,3,4],help="File concurrency (0 uses the app's automatic policy)")
    parser.add_argument("--copies",type=int,choices=(1,2),default=1,help="Number of separately named files per source PDF")
    parser.add_argument("--files",type=int,choices=range(1,25),help="Process this many files, overriding --copies")
    args=parser.parse_args()
    if args.baseline and 0 in args.lanes:
        parser.error("Legacy split queues require an explicit lane count")
    base=args.directory.resolve()
    inputs=base/"inputs"
    if not inputs.exists():
        create_cases(inputs)
    hashes=json.loads((inputs/"sha256.json").read_text())
    assert len(hashes)==12 and all(hashlib.sha256((inputs/name).read_bytes()).hexdigest()==digest for name,digest in hashes.items())
    if args.compare_to and args.exe:
        out=Path(tempfile.mkdtemp(prefix="paired-",dir=base))
        print(out,flush=True)
        rows=[]
        for repeat in range(2):
            for lanes in (args.lanes if repeat==0 else reversed(args.lanes)):
                # Alternate which build goes first for each level, then reverse the pair.
                versions=[("old",args.compare_to),("new",args.exe)]
                if (args.lanes.index(lanes)+repeat)%2:
                    versions.reverse()
                for version,exe in versions:
                    row=run(exe.resolve(),out/f"{repeat+1}-{lanes}-{version}",inputs,lanes,args.baseline and version=="old",args.copies,args.files)
                    rows.append(dict(version=version,repeat=repeat+1,**row))
                    (out/"summary.json").write_text(json.dumps(rows,indent=2))
    elif args.exe:
        out=Path(tempfile.mkdtemp(prefix="baseline-" if args.baseline else "updated-", dir=base))
        print(out,flush=True)
        rows=[]
        for lanes in args.lanes:
            rows.append(run(args.exe.resolve(),out/str(lanes),inputs,lanes,args.baseline,args.copies,args.files))
            (out/"summary.json").write_text(json.dumps(rows,indent=2))
