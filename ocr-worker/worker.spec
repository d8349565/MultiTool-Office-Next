# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

# Keep the bundled OCR models/config; discover Python imports normally instead
# of collecting ONNX's training, conversion, quantization and test toolchains.
a = Analysis(
    [str(Path(SPECPATH) / "worker.py")],
    datas=collect_data_files("rapidocr_onnxruntime"),
    excludes=[
        "onnxruntime.tools",
        "onnxruntime.transformers",
        "onnxruntime.quantization",
        "onnxruntime.training",
        "onnxruntime.datasets",
    ],
)

# Still-image OCR never loads OpenCV's optional FFmpeg video plugin. The pinned
# ONNX Python extension contains its own engine; onnxruntime.dll is the separate
# C API runtime, not a dependency of onnxruntime_pybind11_state.pyd.
a.binaries = [
    entry for entry in a.binaries
    if not Path(entry[0]).name.lower().startswith("opencv_videoio_ffmpeg")
    and entry[0].replace("\\", "/").lower() != "onnxruntime/capi/onnxruntime.dll"
]

pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ocr-worker",
    console=True,
    strip=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="ocr-worker")
