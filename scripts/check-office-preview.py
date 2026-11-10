"""Run against the built worker and public Apache POI fixtures (test-data/).

Usage: python scripts/check-office-preview.py <fixture-directory>
Copy spreadsheet/Simple.xls and slideshow/{basic_test_ppt_file.ppt,SampleShow.pptx}
from https://github.com/apache/poi/tree/trunk/test-data into that directory.
"""
import json
from pathlib import Path
import subprocess
import sys

worker = Path(__file__).resolve().parents[1] / "src-tauri/binaries/ocr-worker/ocr-worker.exe"
directory = Path(sys.argv[1]).resolve()
cases = [
    ("Simple.xls", 1, 0, "replaceMe"),
    ("Simple.xls", 1, 1, ""),
    ("basic_test_ppt_file.ppt", 1, 0, "This is a test title"),
    ("basic_test_ppt_file.ppt", 2, 0, "This is the title on page 2"),
    ("SampleShow.pptx", 1, 0, "Title of the first slide"),
    ("SampleShow.pptx", 2, 0, "This is the second slide"),
]
requests = [dict(id=str(i), version=1, op="file_preview", path=str((directory / name).resolve(strict=True)),
                 page=page, sheet=sheet) for i, (name, page, sheet, _) in enumerate(cases)]
response = subprocess.run([worker], input="\n".join(map(json.dumps, requests)) + "\n",
                          encoding="utf-8", stdout=subprocess.PIPE, timeout=30, check=True)
replies = [json.loads(line) for line in response.stdout.splitlines()]
assert len(replies) == len(cases)
for i, ((name, page, sheet, expected), reply) in enumerate(zip(cases, replies)):
    assert reply["id"] == str(i) and reply["kind"] == "file_preview", reply
    preview = reply["preview"]
    if name.endswith(".xls"):
        assert preview["kind"] == "table" and preview["sheet"] == sheet
        assert preview["sheets"] == ["Sheet1", "Sheet2", "Sheet3"]
        assert preview["rows"] == ([[expected]] if expected else [])
    else:
        assert preview["kind"] == "text" and preview["page"] == page and preview["pageCount"] == 2
        assert preview["text"].startswith(expected), preview
    print(f"PASS {name}, page {page}, worksheet {sheet + 1}")
