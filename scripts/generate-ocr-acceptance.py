"""Generate fictional, raster-only OCR acceptance cases; never invoke OCR."""
import hashlib
import json
import random
from datetime import datetime
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "test-results/ocr-acceptance-20261101"
OUT = BASE / "cases"
W, H = 1654, 2339  # A4 at 200 DPI
FONT = "C:/Windows/Fonts/msyh.ttc"
CASES = [
    ("星湾测试商贸有限公司", ["办公椅"], "2026-01-08", "基准单产品", 1),
    ("云杉虚构设备有限公司", ["标签打印机", "条码扫描器"], "2026/02/17", "斜杠日期、双产品、位置右移", 1),
    ("青禾测试文具有限公司", ["档案柜", "文件夹", "订书机"], "2026.03.26", "点分日期、三产品、多页干扰", 2),
    ("望舒虚构科技有限公司", ["无线键盘", "便携显示器"], "2026年4月9日", "中文日期、浅灰扫描", 1),
    ("松岚测试供应有限公司", ["工业风扇"], "2026-05-30", "单产品、多页不同客户干扰", 2),
    ("北辰虚构实业有限公司", ["防静电手套", "精密螺丝刀", "工具收纳盒"], "2026/6/3", "单数字月日、轻微模糊", 1),
    ("澄溪测试采购有限公司", ["会议白板", "磁性板擦"], "2026.07.14", "PNG、左移与表格线", 1),
    ("栖岩虚构商贸有限公司", ["不锈钢水壶"], "2026年8月21日", "PNG、中文日期、轻微纸纹", 1),
    ("晓川测试办公有限公司", ["网络交换机", "六类网线", "理线架"], "2026-9-6", "PNG、三产品、较小字号", 1),
    ("锦帆虚构器材有限公司", ["数字万用表", "绝缘测试笔"], "2026/10/28", "PNG、轻微模糊、边缘阴影", 1),
]


def main():
    original = (BASE / "profiles.json").read_bytes()
    profile = json.loads(original)[0]
    assert profile["dpi"] == 200 and profile["pages"] == "1"
    OUT.mkdir(parents=True, exist_ok=True)
    entries, thumbs = [], []
    for i, (customer, products, date, scenario, pages) in enumerate(CASES, 1):
        rng = random.Random(i)
        page = Image.new("RGB", (W, H), (250, 249, 246) if i in (4, 8) else "white")
        d = ImageDraw.Draw(page)
        ink = (79, 79, 79) if i == 4 else (25, 25, 25)
        boxes = []

        def put(text, x, y, size=35, field=None):
            font = ImageFont.truetype(FONT, size)
            box = d.textbbox((x, y), text, font=font)
            d.text((x, y), text, font=font, fill=ink)
            if field:
                region = next(r for r in profile["regions"] if r["fieldKey"] == field)
                bounds = [region["x"] * W, region["y"] * H,
                          (region["x"] + region["width"]) * W,
                          (region["y"] + region["height"]) * H]
                assert bounds[0] <= box[0] < box[2] <= bounds[2], (i, field, box, bounds)
                assert bounds[1] <= box[1] < box[3] <= bounds[3], (i, field, box, bounds)
                boxes.append({"field": field, "text": text, "bbox": box, "region_bbox": bounds})

        dx = [0, 12, -5, 8, -3, 5, -7, 4, 6, -2][i - 1]
        put("报价单", 710, 55, 52)
        put("虚构测试样本 · 不可用于交易", 950, 200, 27)
        put("客户名称：" + customer, 36 + dx, 350, 33 if i != 9 else 31, "客户名称")
        put("报价日期：" + date, 1040, 350, 30, "日期")
        put("编号：TEST-%03d" % i, 1000, 535, 30)
        for n, product in enumerate(products):
            y = 710 + n * (185 if i % 2 else 155)
            d.line((30, y - 22, W - 45, y - 22), fill=(165, 165, 165), width=2)
            put("产品名称：" + product, 36 + dx, y, 34 if i != 9 else 30, "产品名称")
            put("数量：%d    单位：件    单价：%d.00" % (3 + i * (n + 1), 80 + 37 * i), 860, y, 29)
        d.line((795, 655, 795, 1530), fill=(170, 170, 170), width=2)
        put("说明：以下信息为框外核对用，不属于本单字段。", 50, 1720, 30)
        put("客户名称：框外虚构公司", 50, 1790, 32)
        put("产品名称：框外干扰商品    日期：2031-12-31", 50, 1850, 32)
        put("测试用途 / TEST ONLY    第 1 页", 480, 2190, 28)
        if i == 8:
            for _ in range(1800):
                x, y = rng.randrange(W), rng.randrange(H)
                d.point((x, y), fill=(210, 210, 205))
        if i == 10:
            for x in range(25):
                d.line((x, 0, x, H), fill=(205 + x, 205 + x, 205 + x))
        if i in (6, 10):
            page = page.filter(ImageFilter.GaussianBlur(0.65 if i == 6 else 0.45))
        suffix = ".pdf" if i <= 6 else ".png"
        path = OUT / ("case-%02d" % i + suffix)
        extra = []
        if pages == 2:
            second = Image.new("RGB", (W, H), "white")
            sd = ImageDraw.Draw(second)
            for n, line in enumerate(["报价单（第二页干扰，不应识别）", "客户名称：第二页虚构集团", "产品名称：错误候选商品", "报价日期：2032-11-29", "仅供测试"]):
                sd.text((60, 180 + n * 190), line, font=ImageFont.truetype(FONT, 40), fill="black")
            extra.append(second)
        if suffix == ".pdf":
            page.save(path, "PDF", resolution=200, save_all=True, append_images=extra)
            doc = pdfium.PdfDocument(path)
            assert len(doc) == pages
            doc.close()
        else:
            page.save(path, dpi=(200, 200))
        normalized = date.replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-").replace(".", "-")
        expected = {"客户名称": customer, "产品名称": "、".join(products), "日期": datetime.strptime(normalized, "%Y-%m-%d").strftime("%Y%m%d")}
        filename = profile["filenamePattern"].format(**expected) + suffix
        entries.append({"id": "case-%02d" % i, "path": str(path.relative_to(ROOT)).replace("\\", "/"), "format": suffix[1:], "pages": pages, "recognized_pages": [1], "scenario": scenario, "expected_fields": expected, "expected_products": products, "displayed_date": date, "expected_filename": filename, "text_geometry": boxes, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        thumb = page.copy()
        thumb.thumbnail((331, 468))
        thumbs.append(thumb)
    sheet = Image.new("RGB", (5 * 351, 2 * 510), "#dddddd")
    draw = ImageDraw.Draw(sheet)
    for i, thumb in enumerate(thumbs):
        x, y = (i % 5) * 351, (i // 5) * 510
        sheet.paste(thumb, (x + 10, y + 30))
        draw.text((x + 10, y + 4), "case-%02d" % (i + 1), font=ImageFont.truetype(FONT, 20), fill="black")
    sheet.save(OUT / "contact-sheet.jpg", quality=90)
    manifest = {"purpose": "Fictional OCR acceptance fixtures; ground truth authored before OCR", "profile_sha256": hashlib.sha256(original).hexdigest(), "dpi": 200, "canvas_pixels": [W, H], "cases": entries}
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    assert (BASE / "profiles.json").read_bytes() == original
    assert len(entries) == 10
    print("Generated 6 raster PDFs (2 multipage), 4 PNGs, manifest and contact sheet.")


if __name__ == "__main__":
    main()
