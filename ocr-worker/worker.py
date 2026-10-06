"""Offline OCR-only worker. Protocol v1: one JSON request per line, page/done/error events.

No service credentials, HTTP clients, shell commands or write operations belong here.
"""
import contextlib
import json
import os
from pathlib import Path
import sys
import time
import io
import base64
import math

os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
PROTOCOL = 1
MAX_PIXELS = 24_000_000
_protocol_output = None


def isolate_protocol_output():
    """Keep native library stdout writes away from the JSON protocol pipe."""
    global _protocol_output
    protocol_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetStdHandle.argtypes = [ctypes.c_uint32]
        kernel32.GetStdHandle.restype = ctypes.c_void_p
        kernel32.SetStdHandle.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        kernel32.SetStdHandle.restype = ctypes.c_int
        kernel32.SetStdHandle(0xFFFFFFF5, kernel32.GetStdHandle(0xFFFFFFF4))
    _protocol_output = os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)


def pages_for(spec, count):
    if spec == "all":
        return range(count)
    result = set()
    for part in spec.split(","):
        bounds = [int(x) for x in part.strip().split("-")]
        if len(bounds) not in (1, 2) or bounds[0] < 1:
            raise ValueError("页范围无效")
        end = bounds[-1]
        if end < bounds[0] or end > 10000:
            raise ValueError("页范围无效")
        result.update(range(bounds[0] - 1, min(end, count)))
    if not result:
        raise ValueError("所选页不在文件中")
    return sorted(result)


def emit(request_id, kind, **values):
    _protocol_output.write(json.dumps(dict(version=PROTOCOL, id=request_id, kind=kind, **values), ensure_ascii=False) + "\n")


def region_boxes(regions, page, width, height):
    if not isinstance(regions, list) or len(regions) > 20:
        raise ValueError("识别区域无效，最多 20 个区域")
    boxes = []
    for r in regions:
        x, y, w, h = (r[k] for k in ("x", "y", "width", "height"))
        if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1.000001 or y+h > 1.000001:
            raise ValueError("识别区域必须在页面内")
        if r["page"] in (0, page):
            pad_x = int(width * 0.03)  # 水平左右各外扩 3% 安全冗余，防止框选切掉首字母
            pad_y = int(height * 0.02) # 垂直上下各外扩 2% 安全冗余
            left = max(0, int(x * width) - pad_x)
            top = max(0, int(y * height) - pad_y)
            right = min(width, math.ceil((x + w) * width) + pad_x)
            bottom = min(height, math.ceil((y + h) * height) + pad_y)
            if right <= left or bottom <= top:
                raise ValueError("识别区域过小")
            boxes.append((left, top, right, bottom))
    return boxes if regions else [(0, 0, width, height)]


def images(path, spec, dpi, skip, regions=None, metadata=None):
    from PIL import Image, ImageOps
    if path.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(str(path))
        try:
            if metadata is not None:
                metadata["pageCount"] = len(doc)
            for index in pages_for(spec, len(doc)):
                if index + 1 in skip or regions and not any(r["page"] in (0, index+1) for r in regions):
                    continue
                page = doc.get_page(index)
                try:
                    scale = dpi / 72
                    if page.get_width() * page.get_height() * scale * scale > MAX_PIXELS:
                        raise ValueError("页面过大，请降低渲染 DPI")
                    bitmap = page.render(scale=scale)
                    try:
                        yield index + 1, bitmap.to_pil().convert("RGB")
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        finally:
            doc.close()
    else:
        with Image.open(path) as source:
            if metadata is not None:
                metadata["pageCount"] = getattr(source, "n_frames", 1)
            for index in pages_for(spec, getattr(source, "n_frames", 1)):
                if index + 1 in skip or regions and not any(r["page"] in (0, index+1) for r in regions):
                    continue
                source.seek(index)
                if source.width * source.height > MAX_PIXELS:
                    raise ValueError("图片超过 2400 万像素，请先缩小图片")
                yield index + 1, ImageOps.exif_transpose(source).convert("RGB")


def main():
    # Imports/init can be noisy: keep stdout exclusively for the wire protocol.
    engine = None
    for raw in sys.stdin:
        request_id = ""
        try:
            request = json.loads(raw)
            request_id = request["id"]
            if request.get("version") != PROTOCOL:
                raise ValueError("OCR 协议版本不兼容")
            if request.get("op") == "shutdown":
                return
            if request.get("op") == "file_preview":
                from file_preview import preview_file
                page = int(request.get("page", 1))
                sheet = int(request.get("sheet", 0))
                if not 1 <= page <= 10000 or not 0 <= sheet < 32:
                    raise ValueError("预览页码或工作表无效")
                result = preview_file(Path(request["path"]), page, sheet, images)
                emit(request_id, "file_preview", preview=result)
                continue
            if request.get("op") not in ("recognize", "preview"):
                raise ValueError("未知 OCR 操作")
            path = Path(request["path"])
            if path.suffix.lower() not in (".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
                raise ValueError("不支持的文件类型")
            dpi = int(request["dpi"])
            if not 100 <= dpi <= 400:
                raise ValueError("DPI 超出范围")
            if request["op"] == "preview":
                preview_pages = images(path, request["pages"], 100, set())
                try:
                    number, image = next(preview_pages)
                    try:
                        image.thumbnail((1280, 1280))
                        output = io.BytesIO()
                        image.save(output, format="PNG")
                        emit(request_id, "preview", image="data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"), page=number)
                    finally:
                        image.close()
                finally:
                    preview_pages.close()
                continue
            started = time.monotonic()
            with contextlib.redirect_stdout(sys.stderr):
                import numpy as np
                if engine is None:
                    from rapidocr_onnxruntime import RapidOCR
                    # The pinned wheel includes all ONNX model files; no downloads.
                    engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
            emit(request_id, "ready", loadMs=round((time.monotonic() - started) * 1000))
            regions = request.get("regions", [])
            for number, image in images(path, request["pages"], dpi, set(request.get("skip", [])), regions):
                started = time.monotonic()
                try:
                    lines = []
                    seen = set()
                    for left, top, right, bottom in region_boxes(regions, number, image.width, image.height):
                        crop = image if (left, top, right, bottom) == (0, 0, image.width, image.height) else image.crop((left, top, right, bottom))
                        try:
                            with contextlib.redirect_stdout(sys.stderr):
                                result, _ = engine(np.asarray(crop))
                            for box, text, score in result or []:
                                points = [[float(x)+left, float(y)+top] for x, y in box]
                                key = (str(text).strip(), tuple(round(v/5) for p in points for v in p))
                                if key[0] and key not in seen:
                                    seen.add(key)
                                    lines.append(dict(text=key[0], page=number, score=float(score), box=points, page_size=[image.width, image.height]))
                        finally:
                            if crop is not image:
                                crop.close()
                    lines.sort(key=lambda line: (sum(p[1] for p in line["box"]) // 60, sum(p[0] for p in line["box"])))
                    emit(request_id, "page", lines=lines, page=number, elapsedMs=round((time.monotonic() - started) * 1000))
                finally:
                    image.close()
            emit(request_id, "done")
        except Exception as error:
            emit(request_id, "error", error=f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    isolate_protocol_output()
    main()
