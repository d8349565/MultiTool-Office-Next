"""XLSX 单元格样式与数字格式解析。

只读取 styles/theme 的 XML 并输出白名单字段（颜色一律是 #rrggbb，尺寸是数字），
不执行公式、不加载外部资源；仅使用标准库，不增加打包体积。
"""
import colorsys
import datetime
import math
import operator
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
HEX6 = re.compile(r"[0-9A-Fa-f]{6}")
HEX_ARGB = re.compile(r"[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?")

# theme 属性的下标顺序与 clrScheme 子节点顺序不同（0/1、2/3 互换）。
THEME_KEYS = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
# Excel 标准索引色板（indexed 8–63；0–7 与 8–15 相同）。
INDEXED = (
    "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 "
    "9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF "
    "00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 "
    "003366 339966 003300 333300 993300 993366 333399 333333"
).split()
NAMED_COLORS = {"red": "#ff0000", "blue": "#0000ff", "green": "#008000", "black": "#000000", "white": "#ffffff", "yellow": "#ffff00", "magenta": "#ff00ff", "cyan": "#00ffff"}
CONDITION = re.compile(r"(<=|>=|<>|=|<|>)([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)")
COMPARE = {"<": operator.lt, ">": operator.gt, "<=": operator.le, ">=": operator.ge, "=": operator.eq, "<>": operator.ne}
# 边框样式 -> (线宽 px, 线型)；双线至少需要 3px 才能显示。
BORDERS = {
    "thin": (1, "solid"), "hair": (1, "dotted"), "dotted": (1, "dotted"), "dashed": (1, "dashed"), "dashDot": (1, "dashed"), "dashDotDot": (1, "dashed"), "slantDashDot": (1, "dashed"),
    "medium": (2, "solid"), "mediumDashed": (2, "dashed"), "mediumDashDot": (2, "dashed"), "mediumDashDotDot": (2, "dashed"),
    "thick": (3, "solid"), "double": (3, "double"),
}
BUILTIN_FORMATS = {
    1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
    14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm",
    37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
    45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss", 49: "@",
}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def children(parent, tag):
    node = parent.find(S + tag) if parent is not None else None
    return list(node) if node is not None else []


def on(node):
    return node is not None and node.get("val", "1") not in {"0", "false"}


def theme_colors(root):
    scheme = root.find(f"{A}themeElements/{A}clrScheme")
    values = {}
    for node in scheme if scheme is not None else []:
        child = next(iter(node), None)
        if child is None:
            continue
        value = child.get("val") if child.tag == A + "srgbClr" else child.get("lastClr")
        if value and HEX6.fullmatch(value):
            values[node.tag.replace(A, "")] = value
    return [values.get(key) for key in THEME_KEYS]


def apply_tint(base, tint):
    red, green, blue = (int(base[index:index + 2], 16) / 255 for index in (0, 2, 4))
    hue, light, saturation = colorsys.rgb_to_hls(red, green, blue)
    light = light * (1 + tint) if tint < 0 else light * (1 - tint) + tint
    red, green, blue = colorsys.hls_to_rgb(hue, min(1, max(0, light)), saturation)
    return "{:02x}{:02x}{:02x}".format(round(red * 255), round(green * 255), round(blue * 255))


def color(node, theme):
    """把 rgb/theme/indexed 颜色统一成 #rrggbb；自动色或无法识别时返回 None。"""
    if node is None:
        return None
    base = None
    rgb = node.get("rgb")
    try:
        if rgb and HEX_ARGB.fullmatch(rgb):
            base = rgb[-6:] if len(rgb) == 6 else rgb[2:]
        elif node.get("theme") is not None:
            base = theme[int(node.get("theme"))]
        elif node.get("indexed") is not None:
            index = int(node.get("indexed"))
            base = INDEXED[index - 8 if index >= 8 else index] if 0 <= index < 64 else None
        if base is None:
            return None
        tint = float(node.get("tint", "0") or 0)
        if tint and math.isfinite(tint):
            base = apply_tint(base, max(-1, min(1, tint)))
    except (ValueError, IndexError):
        return None
    return "#" + base.lower()


def parse_font(node, theme):
    size = node.find(S + "sz")
    try:
        points = float(size.get("val")) if size is not None else 11.0
    except (TypeError, ValueError):
        points = 11.0
    underline = node.find(S + "u")
    return dict(
        b=on(node.find(S + "b")), i=on(node.find(S + "i")), s=on(node.find(S + "strike")),
        u=underline is not None and underline.get("val", "single") != "none",
        sz=points if 1 <= points <= 72 else 11.0, c=color(node.find(S + "color"), theme),
    )


def parse_fill(node, theme):
    pattern = node.find(S + "patternFill")
    if pattern is None:
        stop = node.find(f"{S}gradientFill/{S}stop/{S}color")
        return color(stop, theme)
    return color(pattern.find(S + "fgColor"), theme) if pattern.get("patternType") == "solid" else None


def parse_border(node, theme):
    result = {}
    for key, side in (("l", "left"), ("r", "right"), ("t", "top"), ("b", "bottom")):
        item = node.find(S + side)
        style = BORDERS.get(item.get("style", "")) if item is not None else None
        if style:
            result[key] = [style[0], style[1], color(item.find(S + "color"), theme) or "#000000"]
    return result


def pick(items, index):
    try:
        return items[int(index)] if 0 <= int(index) < len(items) else None
    except (TypeError, ValueError):
        return None


def parse_styles(root, theme):
    """返回 {xfs, formats, size}：xfs 为每个 cellXfs 的样式摘要。"""
    formats = {}
    for item in children(root, "numFmts"):
        try:
            formats[int(item.get("numFmtId"))] = item.get("formatCode", "")
        except (TypeError, ValueError):
            pass
    fonts = [parse_font(node, theme) for node in children(root, "fonts")]
    fills = [parse_fill(node, theme) for node in children(root, "fills")]
    borders = [parse_border(node, theme) for node in children(root, "borders")]
    base_size = fonts[0]["sz"] if fonts else 11.0
    xfs = []
    for xf in children(root, "cellXfs"):
        font = pick(fonts, xf.get("fontId", "0")) or {}
        css = {}
        for key in "bisu":
            if font.get(key):
                css[key] = 1
        if font.get("c") and font["c"] != "#000000":
            css["c"] = font["c"]
        if font.get("sz") and font["sz"] != base_size:
            css["sz"] = font["sz"]
        fill = pick(fills, xf.get("fillId", "0"))
        if fill and fill.lower() != "#ffffff":
            css["bg"] = fill
        for key, edge in (pick(borders, xf.get("borderId", "0")) or {}).items():
            css["b" + key] = edge
        align = xf.find(S + "alignment")
        horizontal = None
        if align is not None:
            horizontal = align.get("horizontal")
            vertical = {"center": "middle", "top": "top"}.get(align.get("vertical", ""))
            if vertical:
                css["v"] = vertical
            if align.get("wrapText") in {"1", "true"}:
                css["w"] = 1
            try:
                indent = int(align.get("indent", "0"))
            except ValueError:
                indent = 0
            if 0 < indent <= 15 and horizontal in {None, "general", "left", "right"}:
                css["ind"] = indent
        try:
            code = int(xf.get("numFmtId", "0"))
        except ValueError:
            code = 0
        xfs.append(dict(fmt=formats.get(code) or BUILTIN_FORMATS.get(code, "General"), css=css, h=horizontal))
    return dict(xfs=xfs, formats=formats, size=base_size)


def cell_format(styles, index):
    xf = pick(styles["xfs"], index)
    return xf["fmt"] if xf else "General"


def cell_style(styles, index, cls, override):
    """cls：n 数字（常规右对齐）/ t 文本（左对齐）/ c 布尔与错误（居中）。"""
    xf = pick(styles["xfs"], index) or dict(css={}, h=None)
    style = dict(xf["css"])
    horizontal = xf["h"]
    if horizontal in {None, "general", "fill"}:
        horizontal = {"n": "right", "c": "center"}.get(cls)
    elif horizontal in {"centerContinuous", "distributed"}:
        horizontal = "center"
    if horizontal in {"left", "center", "right", "justify"}:
        style["h"] = horizontal
    if override:
        style["c"] = override
    return style


# ---- 数字格式 ----

def split_sections(code):
    parts, buffer, quoted, escaped = [], [], False, False
    for character in code:
        if escaped:
            buffer.append(character)
            escaped = False
            continue
        if character == "\\":
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif character == ";" and not quoted:
            parts.append("".join(buffer))
            buffer = []
            continue
        buffer.append(character)
    parts.append("".join(buffer))
    return parts


def tokenize(section):
    """拆分文字、格式字符、条件与累计时长标记；同时提取 [Red] 这类颜色。"""
    tokens, color_name, index = [], None, 0
    while index < len(section):
        character = section[index]
        if character == '"':
            end = section.find('"', index + 1)
            end = len(section) if end < 0 else end
            tokens.append(("lit", section[index + 1:end]))
            index = end + 1
        elif character == "\\" and index + 1 < len(section):
            tokens.append(("lit", section[index + 1]))
            index += 2
        elif character == "_" and index + 1 < len(section):
            tokens.append(("lit", " "))
            index += 2
        elif character == "*" and index + 1 < len(section):
            index += 2
        elif character == "[":
            end = section.find("]", index)
            end = len(section) if end < 0 else end
            body = section[index + 1:end]
            index = end + 1
            if body.startswith("$"):
                symbol = body[1:].split("-")[0]
                if symbol:
                    tokens.append(("lit", symbol))
            elif body.lower() in NAMED_COLORS:
                color_name = NAMED_COLORS[body.lower()]
            elif body.lower() in {"h", "hh", "m", "mm", "s", "ss"}:
                tokens.append(("elapsed", body.lower()))
            elif body.startswith(("<", ">", "=")):
                tokens.append(("condition", body))
        else:
            tokens.append(("fmt", character))
            index += 1
    return tokens, color_name


def general(number):
    if number == int(number) and abs(number) < 1e11:
        return str(int(number))
    text = format(number, ".10g")
    if "e" in text:
        mantissa, exponent = text.split("e")
        return f"{mantissa}E{exponent[0]}{exponent[1:].lstrip('0').rjust(2, '0')}"
    return text


def format_scientific(number, tokens, position):
    """number 带符号；tokens[position] 是 E，其后一位是 + 或 -。"""
    mantissa = tokens[:position]
    exponent_digits = 0
    cursor = position + 2
    while cursor < len(tokens) and tokens[cursor] == ("fmt", "0"):
        exponent_digits += 1
        cursor += 1
    if not any(kind == "fmt" and value in "0#?" for kind, value in mantissa):
        return None
    fraction, seen_point = 0, False
    for kind, value in mantissa:
        if kind == "fmt" and value == ".":
            seen_point = True
        elif seen_point and kind == "fmt" and value in "0#?":
            fraction += 1
    digits, exponent = ("%.*E" % (fraction, abs(number))).split("E")
    sign = "-" if exponent[0] == "-" else "+" if tokens[position + 1][1] == "+" else ""
    result = f"{digits}E{sign}{exponent[1:].lstrip('0').rjust(max(1, exponent_digits), '0')}"
    lead = "".join(value for kind, value in mantissa if kind == "lit")
    tail = "".join(value for kind, value in tokens[cursor:] if kind == "lit")
    return ("-" if number < 0 else "") + lead + result + tail


def format_decimal(number, tokens, negative):
    """按 0 # ? , . % 占位符格式化；返回 None 表示交给“常规”处理。"""
    for position, (kind, value) in enumerate(tokens):
        if kind == "fmt" and value in "Ee" and position + 1 < len(tokens) and tokens[position + 1][0] == "fmt" and tokens[position + 1][1] in "+-":
            return format_scientific(-abs(number) if negative else abs(number), tokens, position)
    slots = [index for index, (kind, value) in enumerate(tokens) if kind == "fmt" and value in "0#?.,"]
    if any(kind == "fmt" and value == "/" for kind, value in tokens) and any(kind == "fmt" and value in "?#0" for kind, value in tokens):
        return None
    percent = sum(1 for kind, value in tokens if kind == "fmt" and value == "%")
    if slots:
        spec = "".join(tokens[index][1] for index in range(slots[0], slots[-1] + 1) if tokens[index][0] == "fmt" and tokens[index][1] in "0#?.,")
        scale = len(spec) - len(spec.rstrip(","))
        whole, _, fraction = spec.rstrip(",").partition(".")
        fraction = fraction.replace(",", "")
        scale += len(whole) - len(whole.rstrip(","))
        whole = whole.rstrip(",")
        grouped = "," in whole
        required_whole = whole.count("0")
        decimals = sum(1 for item in fraction if item in "0#?")
        required_fraction = fraction.count("0")
    else:
        scale = decimals = required_whole = required_fraction = 0
        grouped = False
    try:
        value = Decimal(repr(abs(number))).scaleb(2 * percent - 3 * scale)
        value = value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return None
    text = format(value, "f")
    digits, _, remainder = text.partition(".")
    if grouped:
        digits = f"{int(digits):,}"
    if required_whole == 0 and digits == "0":
        digits = ""
    digits = digits.rjust(required_whole, "0")
    while len(remainder) > required_fraction and remainder.endswith("0"):
        remainder = remainder[:-1]
    numeric = digits + ("." + remainder if remainder else "")
    output, placed = [], False
    for index, (kind, item) in enumerate(tokens):
        if slots and slots[0] <= index <= slots[-1]:
            if not placed:
                output.append(numeric)
                placed = True
        elif kind == "lit":
            output.append(item)
        elif item in " -+()$¥€£:/.,%":
            output.append(item)
    sign = "-" if negative and any(character not in "0.,-" for character in numeric) else ""
    return sign + "".join(output)


def ampm_at(tokens, index):
    for name in ("AM/PM", "A/P"):
        chunk = tokens[index:index + len(name)]
        if len(chunk) == len(name) and all(kind == "fmt" for kind, _ in chunk) and "".join(value for _, value in chunk).upper() == name:
            return name
    return None


def format_date(number, tokens, date1904):
    if number < 0:
        return None
    origin = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30 if number >= 60 else 31)
    moment = origin + datetime.timedelta(seconds=round(number * 86400))
    items, index = [], 0
    while index < len(tokens):
        kind, value = tokens[index]
        if kind == "fmt":
            marker = ampm_at(tokens, index)
            if marker:
                items.append(["ampm", marker])
                index += len(marker)
                continue
            if value.lower() in "ymdhs":
                if items and items[-1][0] == "run" and items[-1][1][0] == value.lower():
                    items[-1][1] += value.lower()
                else:
                    items.append(["run", value.lower()])
                index += 1
                continue
        items.append([kind, value])
        index += 1
    runs = [position for position, item in enumerate(items) if item[0] in {"run", "elapsed"}]
    for order, position in enumerate(runs):
        if items[position][0] == "run" and items[position][1][0] == "m":
            before = items[runs[order - 1]][1][0] if order else ""
            after = items[runs[order + 1]][1][0] if order + 1 < len(runs) else ""
            if before == "h" or after == "s":
                items[position][0] = "minute"
    twelve = any(item[0] == "ampm" for item in items)
    output = []
    for kind, value in items:
        length = len(value)
        if kind == "elapsed":
            unit = {"h": 3600, "m": 60, "s": 1}[value[0]]
            output.append(str(round(number * 86400) // unit).zfill(length))
        elif kind == "run" and value[0] == "y":
            output.append(f"{moment.year % 100:02d}" if length <= 2 else f"{moment.year:04d}")
        elif kind == "run" and value[0] == "m":
            name = MONTHS[moment.month - 1]
            output.append(str(moment.month) if length == 1 else f"{moment.month:02d}" if length == 2 else name[:3] if length == 3 else name if length == 4 else name[0])
        elif kind == "run" and value[0] == "d":
            name = DAYS[moment.weekday()]
            output.append(str(moment.day) if length == 1 else f"{moment.day:02d}" if length == 2 else name[:3] if length == 3 else name)
        elif kind == "run" and value[0] == "h":
            hour = (moment.hour % 12 or 12) if twelve else moment.hour
            output.append(str(hour) if length == 1 else f"{hour:02d}")
        elif kind == "minute":
            output.append(str(moment.minute) if length == 1 else f"{moment.minute:02d}")
        elif kind == "run" and value[0] == "s":
            output.append(str(moment.second) if length == 1 else f"{moment.second:02d}")
        elif kind == "ampm":
            short = value == "A/P"
            output.append(("A" if moment.hour < 12 else "P") if short else ("AM" if moment.hour < 12 else "PM"))
        elif kind == "lit":
            output.append(value)
        elif value in " -/:.,()年月日时分秒":
            output.append(value)
    return "".join(output)


def format_value(raw, code, date1904=False):
    """返回 (显示文本, 文字颜色|None)；无法识别的格式回落为 Excel 的“常规”显示。"""
    try:
        number = float(raw)
    except ValueError:
        return raw, None
    if not math.isfinite(number):
        return raw, None
    code = code or "General"
    if code.strip().lower() == "general":
        return general(number), None
    sections = split_sections(code)
    negative = number < 0
    position = 1 if negative and len(sections) > 1 else 2 if number == 0 and len(sections) > 2 else 0
    parsed = [tokenize(section) for section in sections[:3]]
    conditions = [next((value for kind, value in tokens if kind == "condition"), None) for tokens, _ in parsed]
    if any(condition is not None for condition in conditions):
        position = next((index for index, condition in enumerate(conditions) if condition is None), None)
        for index, condition in enumerate(conditions):
            if condition is None:
                continue
            match = CONDITION.fullmatch(condition)
            if match is None or not math.isfinite(float(match[2])):
                return general(number), None
            if COMPARE[match[1]](number, float(match[2])):
                position = index
                break
        if position is None:
            return general(number), None
    tokens, tint = parsed[position]
    fmt = "".join(value for kind, value in tokens if kind == "fmt")
    if not tokens:
        return "", tint
    if fmt == "@":
        return raw, tint
    if "general" in fmt.lower():
        return general(number), tint
    explicit_sign = negative and len(sections) == 1
    is_date = (any(kind == "elapsed" for kind, _ in tokens) or any(character in "ymdhsYMDHS" for character in fmt)) and not any(character in "0#?" for character in fmt)
    try:
        if is_date:
            text = format_date(abs(number) if position == 1 else number, tokens, date1904)
        else:
            text = format_decimal(number, tokens, explicit_sign)
    except (ValueError, OverflowError):
        text = None
    return (general(number) if text is None else text), tint
