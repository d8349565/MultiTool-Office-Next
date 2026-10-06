"""用户主动触发的本地只读预览；不加载链接、宏或外部资源。"""
import base64
import csv
import datetime
import io
import posixpath
import zipfile
import xml.etree.ElementTree as ET

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


def date_value(value, date1904):
    try:
        number = float(value)
        origin = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30 if number >= 60 else 31)
        date = origin + datetime.timedelta(days=number)
        return date.strftime("%Y-%m-%d %H:%M:%S" if number % 1 else "%Y-%m-%d")
    except (ValueError, OverflowError):
        return value


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
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(text.text or "" for text in node.iter(S + "t")) for node in xml_part(archive, "xl/sharedStrings.xml")]
        date_styles = set()
        if "xl/styles.xml" in archive.namelist():
            styles = xml_part(archive, "xl/styles.xml")
            # 只识别标准日期样式；其它数值保留原始缓存值。
            cell_styles = styles.find(S + "cellXfs")
            date_styles = {index for index, style in enumerate(cell_styles if cell_styles is not None else []) if int(style.get("numFmtId", "0")) in set(range(14, 23)) | {45, 46, 47}}
        properties = book.find(S + "workbookPr")
        date1904 = properties is not None and properties.get("date1904") in {"1", "true"}
        worksheet = xml_part(archive, target)
    rows = []
    length = 0
    truncated = len(sheets) > 32
    for row in worksheet.iter(S + "row"):
        if len(rows) >= MAX_ROWS or length >= MAX_CHARS:
            truncated = True
            break
        values = []
        for cell in row.findall(S + "c"):
            column = column_index(cell.get("r", ""))
            if column < 0:
                column = len(values)
            if column >= MAX_COLS:
                truncated = True
                continue
            while len(values) <= column:
                values.append("")
            kind = cell.get("t")
            value = cell.findtext(S + "v", "")
            if kind == "s":
                index = int(value) if value else -1
                value = strings[index] if 0 <= index < len(strings) else ""
            elif kind == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(S + "t"))
            elif kind == "b":
                value = "是" if value == "1" else "否"
            elif int(cell.get("s", "0")) in date_styles and kind not in {"str", "e", "d"}:
                value = date_value(value, date1904)
            if not value and cell.find(S + "f") is not None:
                value = "=" + cell.findtext(S + "f", "")
            limit = min(400, max(0, MAX_CHARS - length))
            truncated |= len(value) > limit
            values[column] = value[:limit]
            length += len(values[column])
        rows.append(values)
    return dict(kind="table", rows=rows, sheets=[node.get("name", "工作表") for node in sheets[:32]], sheet=sheet, truncated=truncated, notice="最多显示 120 行、24 列；公式使用已有缓存值，不计算公式或加载外部链接。")


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
