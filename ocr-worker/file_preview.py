"""用户主动触发的本地只读预览；不加载链接、宏或外部资源。"""
import base64
import csv
import io
import json
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

from sheet_style import cell_format, cell_style, format_value, parse_styles, theme_colors

MAX_FILE = 100 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
MAX_CHARS = 40_000
MAX_ROWS = 120
MAX_COLS = 24
TEXT_TYPES = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".log", ".ini", ".toml", ".rs", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm", ".py", ".sql"}
IMAGE_TYPES = {".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def xml_part(archive, name):
    info = archive.getinfo(name)
    if info.file_size > MAX_XML:
        raise ValueError("文档内部数据过大，请用原程序打开")
    with archive.open(info) as source:
        data = source.read(MAX_XML + 1)
    declarations = data.replace(b"\x00", b"").upper()
    if len(data) > MAX_XML or b"<!DOCTYPE" in declarations or b"<!ENTITY" in declarations:
        raise ValueError("文档包含不支持的 XML 声明或超出预览限制")
    return ET.fromstring(data)


def decode_text(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    if b"\x00" in data[:4096]:
        raise ValueError("文件不是可预览的文本，请用原程序打开")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        if error.reason == "unexpected end of data":
            return data.decode("utf-8-sig", errors="replace")
        return data.decode("gb18030", errors="replace")


def text_preview(path):
    with path.open("rb") as source:
        data = source.read(128 * 1024 + 1)
    text = decode_text(data[:128 * 1024])
    truncated = len(data) > 128 * 1024 or len(text) > MAX_CHARS
    text = text[:MAX_CHARS]
    if path.suffix.lower() in {".csv", ".tsv"}:
        # 不计算公式；只把单元格当作普通文字展示。
        reader = csv.reader(io.StringIO(text), delimiter="\t" if path.suffix.lower() == ".tsv" else ",")
        rows = []
        for row in reader:
            if len(rows) == MAX_ROWS:
                truncated = True
                break
            truncated |= len(row) > MAX_COLS or any(len(cell) > 400 for cell in row)
            rows.append([cell[:400] for cell in row[:MAX_COLS]])
        return dict(kind="table", rows=rows, truncated=truncated, notice="最多显示 120 行、24 列；单元格按文字展示。")
    return dict(kind="text", text=text, format="markdown" if path.suffix.lower() in {".md", ".markdown"} else "plain", truncated=truncated, notice="仅在本机读取；最多显示 40,000 个字符。")


def paragraph_text(element):
    return "".join(node.text or "" if node.tag == W + "t" else "\t" if node.tag == W + "tab" else "\n" if node.tag == W + "br" else "" for node in element.iter())


def docx_preview(path):
    with zipfile.ZipFile(path) as archive:
        document = xml_part(archive, "word/document.xml")
    body = document.find(W + "body")
    parts = []
    length = 0
    truncated = False
    for block in body if body is not None else []:
        if block.tag == W + "tbl":
            value = "\n".join(" | ".join(paragraph_text(cell) for cell in row.findall(W + "tc")) for row in block.findall(W + "tr"))
        else:
            value = paragraph_text(block)
        if length + len(value) + 1 > MAX_CHARS:
            parts.append(value[:max(0, MAX_CHARS - length)])
            truncated = True
            break
        parts.append(value)
        length += len(value) + 1
    return dict(kind="text", text="\n".join(parts), format="plain", truncated=truncated, notice="文档正文预览；不还原分页、图表和复杂排版。")


def column_index(reference):
    value = 0
    for character in reference.upper():
        if not "A" <= character <= "Z":
            break
        value = value * 26 + ord(character) - ord("A") + 1
    return value - 1


def shared_string(node):
    # 只取正文与富文本片段；拼音注音（rPh）不属于单元格显示内容。
    parts = []
    for child in node:
        if child.tag == S + "t":
            parts.append(child.text or "")
        elif child.tag == S + "r":
            parts.extend(text.text or "" for text in child.findall(S + "t"))
    return "".join(parts)


def load_styles(archive, names):
    """样式损坏时退回无样式预览，不影响取值。"""
    if "xl/styles.xml" not in names:
        return dict(xfs=[], formats={}, size=11.0)
    theme = []
    try:
        if "xl/theme/theme1.xml" in names:
            theme = theme_colors(xml_part(archive, "xl/theme/theme1.xml"))
        return parse_styles(xml_part(archive, "xl/styles.xml"), theme)
    except (ET.ParseError, ValueError, KeyError):
        return dict(xfs=[], formats={}, size=11.0)


def cell_reference(reference):
    match = re.fullmatch(r"([A-Za-z]{1,3})(\d{1,7})", reference or "")
    return (int(match.group(2)) - 1, column_index(match.group(1))) if match else None


def column_widths(worksheet, count):
    """Excel 列宽（字符）换算成像素：width * 7；默认 64px。"""
    properties = worksheet.find(S + "sheetFormatPr")
    try:
        default = float(properties.get("defaultColWidth")) * 7 if properties is not None and properties.get("defaultColWidth") else 64
    except ValueError:
        default = 64
    widths = [round(default)] * count
    for node in worksheet.iterfind(f"{S}cols/{S}col"):
        try:
            first, last, width = int(node.get("min")) - 1, int(node.get("max")) - 1, float(node.get("width", "0"))
        except (TypeError, ValueError):
            continue
        pixels = 0 if node.get("hidden") in {"1", "true"} or width <= 0 else min(600, max(8, round(width * 7)))
        for index in range(max(first, 0), min(last, count - 1) + 1):
            widths[index] = pixels
    return widths


def merged_ranges(worksheet, row_count, column_count):
    merges = []
    for node in list(worksheet.iterfind(f"{S}mergeCells/{S}mergeCell"))[:2000]:
        start, _, end = node.get("ref", "").partition(":")
        first, last = cell_reference(start), cell_reference(end)
        if not first or not last or first[0] >= row_count or first[1] >= column_count:
            continue
        top, left = min(first[0], last[0]), min(first[1], last[1])
        bottom, right = min(max(first[0], last[0]), row_count - 1), min(max(first[1], last[1]), column_count - 1)
        if (bottom, right) != (top, left):
            merges.append([top, left, bottom, right])
    return merges


def xlsx_preview(path, sheet):
    with zipfile.ZipFile(path) as archive:
        book = xml_part(archive, "xl/workbook.xml")
        sheet_list = book.find(S + "sheets")
        sheets = list(sheet_list) if sheet_list is not None else []
        if not sheets or not 0 <= sheet < min(32, len(sheets)):
            raise ValueError("工作表不存在或超过预览范围")
        relationships = {node.get("Id"): node for node in xml_part(archive, "xl/_rels/workbook.xml.rels")}
        relationship = relationships.get(sheets[sheet].get(R + "id"))
        if relationship is None or relationship.get("TargetMode") == "External":
            raise ValueError("不加载外部工作表")
        target = relationship.get("Target", "")
        target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
        if not target.startswith("xl/") or "\\" in target:
            raise ValueError("工作表路径无效")
        names = set(archive.namelist())
        strings = []
        if "xl/sharedStrings.xml" in names:
            strings = [shared_string(node) for node in xml_part(archive, "xl/sharedStrings.xml")]
        styles = load_styles(archive, names)
        properties = book.find(S + "workbookPr")
        date1904 = properties is not None and properties.get("date1904") in {"1", "true"}
        worksheet = xml_part(archive, target)
    rows, ids, heights = [], [], []
    style_list, style_index, style_cache = [{}], {"{}": 0}, {}

    def style_id(xf, cls, override):
        key = (xf, cls, override)
        if key not in style_cache:
            token = json.dumps(cell_style(styles, xf, cls, override), sort_keys=True, separators=(",", ":"))
            if token not in style_index:
                style_index[token] = len(style_list)
                style_list.append(json.loads(token))
            style_cache[key] = style_index[token]
        return style_cache[key]

    length = 0
    truncated = len(sheets) > 32
    for row in worksheet.iter(S + "row"):
        number = int(row.get("r")) if row.get("r", "").isdigit() else len(rows) + 1
        if number > MAX_ROWS or length >= MAX_CHARS:
            truncated = True
            break
        if number <= len(rows):
            continue
        while len(rows) < number - 1:
            rows.append([])
            ids.append([])
            heights.append(0)
        values, styled = [], []
        for cell in row.findall(S + "c"):
            column = column_index(cell.get("r", ""))
            if column < 0:
                column = len(values)
            if column >= MAX_COLS:
                truncated = True
                continue
            while len(values) <= column:
                values.append("")
                styled.append(0)
            kind = cell.get("t")
            value = cell.findtext(S + "v", "")
            has_cached_value = bool(value) or (kind == "str" and cell.find(S + "v") is not None)
            try:
                xf = int(cell.get("s", "0"))
            except ValueError:
                xf = 0
            override = None
            if kind == "s":
                index = int(value) if value else -1
                value = strings[index] if 0 <= index < len(strings) else ""
            elif kind == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(S + "t"))
            elif kind == "b":
                value = "TRUE" if value == "1" else "FALSE"
            elif kind in {None, "n"} and value:
                value, override = format_value(value, cell_format(styles, xf), date1904)
            if not has_cached_value and not value and cell.find(S + "f") is not None:
                value = "=" + cell.findtext(S + "f", "")
            limit = min(400, max(0, MAX_CHARS - length))
            truncated |= len(value) > limit
            values[column] = value[:limit]
            styled[column] = style_id(xf, "c" if kind in {"b", "e"} else "t" if kind in {"s", "str", "inlineStr", "d"} else "n", override)
            length += len(values[column])
        rows.append(values)
        ids.append(styled)
        try:
            height = round(float(row.get("ht", "0")) * 4 / 3, 1)
        except ValueError:
            height = 0
        heights.append(-1 if row.get("hidden") in {"1", "true"} else min(height, 800) if height > 0 else 0)
    result = dict(kind="table", rows=rows, sheets=[node.get("name", "工作表") for node in sheets[:32]], sheet=sheet, truncated=truncated, notice="最多显示 120 行、24 列；按单元格样式还原，公式使用已有缓存值，不计算公式或加载外部链接，不显示图片、图表与条件格式。")
    if rows:
        merges = merged_ranges(worksheet, MAX_ROWS, MAX_COLS)
        row_count = max(len(rows), max((merge[2] + 1 for merge in merges), default=0))
        columns = max(max(len(row) for row in rows), max((merge[3] + 1 for merge in merges), default=0))
        while len(rows) < row_count:
            rows.append([])
            ids.append([])
            heights.append(0)
        for row, styled in zip(rows, ids):
            row.extend([""] * (columns - len(row)))
            styled.extend([0] * (columns - len(styled)))
        view = worksheet.find(f"{S}sheetViews/{S}sheetView")
        properties = worksheet.find(S + "sheetFormatPr")
        try:
            default_height = round(float(properties.get("defaultRowHeight")) * 4 / 3, 1) if properties is not None and properties.get("defaultRowHeight") else 20
        except ValueError:
            default_height = 20
        result["grid"] = dict(
            styles=style_list, cells=ids, cols=column_widths(worksheet, columns), rowHeights=heights, rowHeight=default_height,
            merges=merges, gridlines=not (view is not None and view.get("showGridLines") in {"0", "false"}),
            baseSize=styles["size"],
        )
    return result


def image_preview(path, page, images):
    metadata = {}
    pages = images(path, str(page), 100, set(), metadata=metadata)
    try:
        number, image = next(pages)
        try:
            image.thumbnail((1280, 1280))
            output = io.BytesIO()
            image.save(output, format="PNG")
            return dict(kind="image", image="data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"), page=number, pageCount=metadata["pageCount"], truncated=False, notice="仅在本机渲染当前页面。")
        finally:
            image.close()
    finally:
        pages.close()


def preview_file(path, page, sheet, images):
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError("文件不存在或超过 100 MB 预览限制，请用原程序打开")
    extension = path.suffix.lower()
    if extension in TEXT_TYPES:
        return text_preview(path)
    if extension == ".docx":
        return docx_preview(path)
    if extension == ".xlsx":
        return xlsx_preview(path, sheet)
    if extension in IMAGE_TYPES:
        return image_preview(path, page, images)
    raise ValueError("此格式暂不支持内容预览，请用原程序打开")
