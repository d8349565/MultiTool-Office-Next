"""Check local layout previews with disposable, fictional OOXML documents.

Usage: .tools/ocr-venv/Scripts/python scripts/check-office-layout.py [--native] [--worker EXE]
--native requires an installed local Office renderer and checks real page pixels.
"""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import subprocess
import tempfile
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ocr-worker"))
from file_preview import preview_file
from office_render import RenderUnavailable
from worker import images

REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"


def relationships(items):
    return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(
        f'<Relationship Id="rId{i}" Type="{REL}{kind}" Target="{target}"/>' for i, (kind, target) in enumerate(items, 1)) + '</Relationships>'


def package(path, parts, types):
    parts["[Content_Types].xml"] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' + ''.join(
        f'<Override PartName="/{name}" ContentType="application/vnd.openxmlformats-officedocument.{kind}+xml"/>' for name, kind in types) + '</Types>'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)


def fixtures(directory):
    from PIL import Image
    image = io.BytesIO()
    Image.new("RGB", (100, 100), (220, 30, 40)).save(image, format="PNG")
    docx = directory / "虚构 排版预览.docx"
    drawing = '<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Fictional red image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="red.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
    package(docx, {
        "_rels/.rels": relationships([("officeDocument", "word/document.xml")]),
        "word/_rels/document.xml.rels": relationships([("image", "media/red.png")]),
        "word/media/red.png": image.getvalue(),
        "word/document.xml": f'<w:document xmlns:w="{W}" xmlns:r="{REL[:-1]}" xmlns:a="{A}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="48"/></w:rPr><w:t>Fictional layout sample</w:t></w:r></w:p><w:p><w:r>{drawing}</w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:fill="20B050"/></w:tcPr><w:p><w:r><w:t>Styled table</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:rPr><w:color w:val="1020E0"/><w:sz w:val="72"/></w:rPr><w:t>Second fictional page</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
    }, [("word/document.xml", "wordprocessingml.document.main")])
    pptx = directory / "虚构 排版预览.pptx"
    ns = f'xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{REL[:-1]}"'
    group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    parts = {
        "_rels/.rels": relationships([("officeDocument", "ppt/presentation.xml")]),
        "ppt/presentation.xml": f'<p:presentation {ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
        "ppt/_rels/presentation.xml.rels": relationships([("slideMaster", "slideMasters/slideMaster1.xml"), ("slide", "slides/slide1.xml"), ("slide", "slides/slide2.xml")]),
        "ppt/slideMasters/slideMaster1.xml": f'<p:sldMaster {ns}><p:cSld><p:spTree>{group}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>',
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([("slideLayout", "../slideLayouts/slideLayout1.xml"), ("theme", "../theme/theme1.xml")]),
        "ppt/slideLayouts/slideLayout1.xml": f'<p:sldLayout {ns} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([("slideMaster", "../slideMasters/slideMaster1.xml")]),
        "ppt/media/red.png": image.getvalue(),
    }
    types = [("ppt/presentation.xml", "presentationml.presentation.main"), ("ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster"), ("ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout")]
    colors = ''.join(f'<a:{name}><a:srgbClr val="{color}"/></a:{name}>' for name, color in [
        ("dk1", "000000"), ("lt1", "FFFFFF"), ("dk2", "333333"), ("lt2", "EEEEEE"),
        ("accent1", "FF0000"), ("accent2", "00FF00"), ("accent3", "0000FF"), ("accent4", "FF00FF"),
        ("accent5", "00FFFF"), ("accent6", "FFFF00"), ("hlink", "0000FF"), ("folHlink", "800080")])
    font = '<a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/>'
    fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    line = f'<a:ln w="9525">{fill}<a:prstDash val="solid"/></a:ln>'
    effect = '<a:effectStyle><a:effectLst/></a:effectStyle>'
    parts["ppt/theme/theme1.xml"] = f'<a:theme xmlns:a="{A}" name="Fictional"><a:themeElements><a:clrScheme name="Fictional">{colors}</a:clrScheme><a:fontScheme name="Fictional"><a:majorFont>{font}</a:majorFont><a:minorFont>{font}</a:minorFont></a:fontScheme><a:fmtScheme name="Fictional"><a:fillStyleLst>{fill * 3}</a:fillStyleLst><a:lnStyleLst>{line * 3}</a:lnStyleLst><a:effectStyleLst>{effect * 3}</a:effectStyleLst><a:bgFillStyleLst>{fill * 3}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'
    types.append(("ppt/theme/theme1.xml", "theme"))
    for page, background in [(1, "FFFFFF"), (2, "1020E0")]:
        picture = '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Fictional red image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="2000000"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
        title = f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="400000"/><a:ext cx="10000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="3600"/><a:t>Fictional slide {page}</a:t></a:r></a:p></p:txBody></p:sp>'
        parts[f"ppt/slides/slide{page}.xml"] = f'<p:sld {ns} show="{1 if page == 1 else 0}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>{group}{title}{picture}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
        parts[f"ppt/slides/_rels/slide{page}.xml.rels"] = relationships([("slideLayout", "../slideLayouts/slideLayout1.xml"), ("image", "../media/red.png")])
        types.append((f"ppt/slides/slide{page}.xml", "presentationml.slide"))
    package(pptx, parts, types)
    return docx, pptx


def pixels(result, color):
    from PIL import Image
    image = Image.open(io.BytesIO(base64.b64decode(result["image"].split(",", 1)[1]))).convert("RGB")
    assert image.width > 500 and image.height > 500, image.size
    red, green, blue = color
    return sum(abs(r - red) < 20 and abs(g - green) < 20 and abs(b - blue) < 20 for r, g, b in image.getdata())


def native_pages(path):
    if "--worker" in sys.argv:
        executable = Path(sys.argv[sys.argv.index("--worker") + 1]).resolve(strict=True)
        requests = [dict(version=1, op="file_preview", id=str(page), path=str(path), page=page, sheet=0) for page in (1, 2)]
        response = subprocess.run([str(executable)], input="\n".join(map(json.dumps, requests)) + "\n",
                                  encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=55, check=True)
        replies = [json.loads(line) for line in response.stdout.splitlines()]
        assert len(replies) == 2, response.stderr
        for page, reply in enumerate(replies, 1):
            assert reply["id"] == str(page) and reply["kind"] == "file_preview", reply
        return [reply["preview"] for reply in replies]
    first = preview_file(path, 1, 0, images)
    with patch("office_render.convert", side_effect=AssertionError("turning pages reconverted the document")):
        second = preview_file(path, 2, 0, images)
    try:
        preview_file(path, 3, 0, images)
    except ValueError:
        pass
    else:
        raise AssertionError("out-of-range page must not silently become a text preview")
    return first, second


with tempfile.TemporaryDirectory(prefix="office-layout-check-") as directory:
    docx, pptx = fixtures(Path(directory))
    for path, expected in [(docx, "Fictional layout sample"), (pptx, "Fictional slide 1")]:
        before = (hashlib.sha256(path.read_bytes()).digest(), path.stat().st_mtime_ns)
        with patch("office_render.convert", side_effect=RenderUnavailable("未安装排版引擎，已使用文字预览")):
            result = preview_file(path, 1, 0, images)
        assert result["kind"] == "text" and expected in result["text"], result
        assert "文字预览" in result["notice"], result["notice"]
        print(f"PASS {path.suffix}: explicit text fallback")
        if "--native" in sys.argv:
            first, second = native_pages(path)
            assert first["kind"] == "image", first.get("notice")
            assert second["kind"] == "image" and first["pageCount"] == second["pageCount"] == 2
            assert first["page"] == 1 and second["page"] == 2 and first["image"] != second["image"]
            assert pixels(first, (220, 30, 40)) > 1000, "embedded picture is missing"
            assert pixels(second, (16, 32, 224)) > 50, "page/slide color is missing"
            if path == docx:
                assert pixels(first, (32, 176, 80)) > 1000, "table formatting is missing"
            print(f"PASS {path.suffix}: real images, colors and two pages (including hidden slide)")
        assert before == (hashlib.sha256(path.read_bytes()).digest(), path.stat().st_mtime_ns), "source was modified"
        assert not path.with_suffix(".pdf").exists(), "PDF was written beside source"
    # A linked image is deliberately not sent to a full Office application.
    linked = Path(directory) / "linked.pptx"
    with zipfile.ZipFile(pptx) as source, zipfile.ZipFile(linked, "w") as destination:
        for item in source.infolist():
            content = source.read(item)
            if item.filename == "ppt/slides/_rels/slide1.xml.rels":
                content = content.replace(b'Target="../media/red.png"', b'Target="https://example.invalid/private.png" TargetMode="External"')
            destination.writestr(item, content)
    with patch("office_render.convert", side_effect=AssertionError("external resource reached renderer")):
        result = preview_file(linked, 1, 0, images)
    assert result["kind"] == "text" and "外部" in result["notice"], result
    print("PASS external-resource document: no renderer launch, source unchanged")
