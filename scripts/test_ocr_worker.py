"""Real offline worker regression, using only temporary synthetic scan pages.

Run: .tools/ocr-venv/Scripts/python.exe scripts/test_ocr_worker.py
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ocr-worker"))
from worker import rgb_image


class WorkerRecognitionTest(unittest.TestCase):
    def test_rgb_reuse_preserves_pixels_and_other_modes_still_convert(self):
        image = Image.new("RGB", (3, 2), (20, 40, 60))
        self.assertIs(rgb_image(image), image)
        self.assertEqual(image.getpixel((1, 1)), (20, 40, 60))
        image.close()
        for mode, color in (("RGBA", (20, 40, 60, 80)), ("L", 90)):
            image = Image.new(mode, (3, 2), color)
            expected = image.convert("RGB")
            converted = rgb_image(image)
            self.assertEqual(converted.tobytes(), expected.tobytes())
            converted.close()
            expected.close()

    def test_page_reuse_preserves_text_boxes_scores_and_reports_work(self):
        base = ROOT / "test-results" / "ocr-performance"
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as folder:
            folder = Path(folder).resolve()
            self.assertTrue(folder.is_relative_to(base.resolve()))
            font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 48)
            pages = []
            expected_text = []
            for number in (1, 2):
                page = Image.new("RGB", (1200, 1600), "white")
                draw = ImageDraw.Draw(page)
                rows = ("SYNTHETIC OCR CHECK", f"Page {number}", "Reference: TEST-2026", "Date: 2026-11-01")
                expected_text.extend(rows)
                for row, text in enumerate(rows):
                    draw.text((70, 100 + row * 100), text, font=font, fill="black")
                pages.append(page)
            path = folder / "synthetic.pdf"
            pages[0].save(path, save_all=True, append_images=pages[1:], resolution=200)
            for page in pages:
                page.close()
            command = [os.environ["OFFICE_OCR_TEST_WORKER"]] if os.environ.get("OFFICE_OCR_TEST_WORKER") else [sys.executable, str(ROOT / "ocr-worker" / "worker.py")]
            with subprocess.Popen(command,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, encoding="utf-8") as process:
                messages = queue.Queue()
                def read():
                    for line in process.stdout:
                        messages.put(json.loads(line))
                threading.Thread(target=read, daemon=True).start()
                def recognize(request_id, pages, skip=(), regions=None, fast_regions=False):
                    request = dict(version=1, id=request_id, op="recognize", path=str(path), pages=pages, dpi=200, skip=list(skip), regions=regions or [], fastRegions=fast_regions)
                    process.stdin.write(json.dumps(request) + "\n")
                    process.stdin.flush()
                    lines = []
                    while True:
                        event = messages.get(timeout=60)
                        self.assertEqual(event["id"], request_id)
                        self.assertNotEqual(event["kind"], "error", event.get("error"))
                        if event["kind"] == "page":
                            lines.extend(event["lines"])
                        if event["kind"] == "done":
                            return lines, event
                try:
                    first, event = recognize("first", "1")
                    self.assertTrue(first, "Synthetic text must actually be recognized")
                    self.assertIn("timings", event)
                    self.assertEqual(event["timings"]["pagesProcessed"], 1)
                    self.assertGreater(event["timings"]["renderMs"], 0)
                    self.assertGreater(event["timings"]["detectMs"], 0)
                    self.assertGreater(event["timings"]["recognizeMs"], 0)
                    self.assertGreater(event["timings"]["workerCpuMs"], 0)
                    full, _ = recognize("full", "all")
                    remaining, event = recognize("remaining", "all", [1])
                    self.assertEqual(first + remaining, full)
                    self.assertEqual(event["timings"]["pagesProcessed"], 1)
                    empty, event = recognize("skip-first", "1", [1])
                    self.assertEqual(empty, [])
                    self.assertEqual(event["timings"]["pagesProcessed"], 0)
                    self.assertEqual(event["timings"]["inferenceMs"], 0)
                    fast, _ = recognize("fast-regions", "all", regions=[dict(page=0, x=0, y=0, width=1, height=1)], fast_regions=True)
                    # Compare to authored truth: the precise baseline can itself
                    # omit spaces. Do not require the fast path to repeat that error.
                    self.assertEqual([line["text"] for line in fast], expected_text)
                    restored, _ = recognize("precise-after-fast", "all")
                    self.assertEqual(restored, full, "Fast region settings must not affect the next precise request")
                finally:
                    process.stdin.close()
                    process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
