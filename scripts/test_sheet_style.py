"""XLSX 原格式预览自检：python scripts/test_sheet_style.py"""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ocr-worker"))
from file_preview import xlsx_preview  # noqa: E402
from sheet_style import BUILTIN_FORMATS, format_value  # noqa: E402

NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

WORKBOOK = f'<workbook {NS} {RNS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'
THEME = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>'
STYLES = f"""<styleSheet {NS}>
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color rgb="FFFF0000"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.59999389629810485"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"/><top style="medium"><color rgb="FF00FF00"/></top><bottom style="thin"/></border></borders>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0"/>
</cellXfs></styleSheet>"""
SHEET = f"""<worksheet {NS}>
<sheetFormatPr defaultRowHeight="15"/>
<sheetViews><sheetView showGridLines="0"/></sheetViews>
<cols><col min="1" max="1" width="20.7109375" customWidth="1"/><col min="3" max="3" width="9" hidden="1"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1"/></row>
<row r="3"><c r="A3" s="2"><v>1234.5</v></c><c r="B3" s="3"><v>0.256</v></c><c r="C3" s="4"><v>45000</v></c><c r="D3" t="b"><v>1</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>"""
SHARED = f'<sst {NS}><si><t>标题</t><rPh sb="0" eb="1"><t>ignored</t></rPh></si></sst>'


def build(sheet=SHEET, styles=STYLES):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/workbook.xml", WORKBOOK)
        archive.writestr("xl/_rels/workbook.xml.rels", RELS)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
        archive.writestr("xl/styles.xml", styles)
        archive.writestr("xl/theme/theme1.xml", THEME)
        archive.writestr("xl/sharedStrings.xml", SHARED)
    buffer.seek(0)
    return buffer


class Formats(unittest.TestCase):
    def check(self, raw, code, expected, tint=None):
        self.assertEqual(format_value(raw, code), (expected, tint), (raw, code))

    def test_numbers(self):
        self.check("1234.5", "#,##0.00", "1,234.50")
        self.check("0.256", "0.0%", "25.6%")
        self.check("1.005", "0.00", "1.01")
        self.check("5", "000", "005")
        self.check("12345", "#,##0,", "12")
        self.check("-1234.5", "#,##0.00;[Red](#,##0.00)", "(1,234.50)", "#ff0000")
        self.check("-3", "0", "-3")
        self.check("-0.001", "0.00", "0.00")
        self.check("1234.5", '"¥"#,##0.00', "¥1,234.50")
        self.check("1234.5", "[$¥-804]#,##0.00", "¥1,234.50")
        self.check("1234567", "0.00E+00", "1.23E+06")
        self.check("0.30000000000000004", "General", "0.3")
        self.check("3", "General", "3")

    def test_dates(self):
        self.check("45000", "yyyy-mm-dd", "2023-03-15")
        self.check("45000.75", "yyyy-mm-dd hh:mm", "2023-03-15 18:00")
        self.check("45000", 'yyyy"年"m"月"d"日"', "2023年3月15日")
        self.check("0.5", "h:mm AM/PM", "12:00 PM")
        self.check("45000.5", "mm:ss", "00:00")
        self.check("45000", "d-mmm-yy", "15-Mar-23")

    def test_scaled_numbers(self):
        self.check("1234", '0.0,"K"', "1.2K")
        self.check("1234567", '0.0,,"M"', "1.2M")
        self.check("-1234567", '0.0,,"M"', "-1.2M")
        self.check("1234567", '#,##0.0,"K"', "1,234.6K")
        self.check("1234", '0,.0"K"', "1.2K")

    def test_elapsed_times(self):
        self.check("1.5", "[h]:mm:ss", "36:00:00")
        self.check("1.5", BUILTIN_FORMATS[46], "36:00:00")
        self.check("1.5", "[h]", "36")
        self.check("0.125", "[hh]", "03")
        self.check("1.5", "[mm]:ss", "2160:00")
        self.check("1.5", "[ss]", "129600")
        self.check("1.5", "h:mm:ss", "12:00:00")
        self.assertEqual(format_value("1.5", "[h]:mm:ss", True), ("36:00:00", None))

    def test_conditional_sections(self):
        code = '[>=100]0" large";0" small"'
        self.check("12", code, "12 small")
        self.check("100", code, "100 large")
        self.check("120", code, "120 large")
        self.check("0", code, "0 small")
        code = '[Green][>=1000]0.0,"K";[Red][<0](0);0'
        self.check("1234", code, "1.2K", "#008000")
        self.check("-12", code, "(12)", "#ff0000")
        self.check("12", code, "12")
        for comparison, raw, expected in (("<", "99", "yes"), ("<=", "100", "yes"), (">", "100", "no"), (">=", "100", "yes"), ("=", "100", "yes"), ("<>", "100", "no")):
            with self.subTest(comparison=comparison):
                self.check(raw, f'[{comparison}100]"yes";"no"', expected)
        self.check("12", '[>=100]0;[<0]0', "12")  # 没有匹配段时回退常规值
        self.check("12", '[>=bad]0" wrong";0', "12")
        self.check("12", '0"[>=100]"', "12[>=100]")  # 引号里的条件只是文字

    def test_text_untouched(self):
        self.assertEqual(format_value("abc", "0.00"), ("abc", None))


class Workbook(unittest.TestCase):
    def test_style_grid(self):
        result = xlsx_preview(build(), 0)
        grid = result["grid"]
        self.assertEqual(result["rows"][0][0], "标题")  # 拼音注音不混入文字
        self.assertEqual(len(result["rows"]), 3)  # 空行按真实行号占位
        self.assertEqual(result["rows"][2][:4], ["¥1,234.50", "25.60%", "2023-03-15", "TRUE"])
        self.assertEqual(grid["merges"], [[0, 0, 0, 1]])
        self.assertEqual(grid["cols"][0], 145)
        self.assertEqual(grid["cols"][2], 0)  # 隐藏列
        self.assertEqual(grid["rowHeights"], [40.0, 0, 0])
        self.assertFalse(grid["gridlines"])
        header = grid["styles"][grid["cells"][0][0]]
        self.assertEqual((header["b"], header["i"], header["c"], header["sz"], header["h"], header["v"], header["w"]), (1, 1, "#ff0000", 14.0, "center", "middle", 1))
        # accent1 + 浅色 60%：Excel 为 B4C6E7，容许量化误差。
        for ours, expected in zip(bytes.fromhex(header["bg"][1:]), bytes.fromhex("b4c6e7")):
            self.assertLessEqual(abs(ours - expected), 2)
        self.assertEqual((header["bt"], header["bl"]), ([2, "solid", "#00ff00"], [1, "solid", "#000000"]))
        self.assertEqual(grid["styles"][grid["cells"][2][0]]["h"], "right")  # 数字默认右对齐
        self.assertEqual(grid["styles"][grid["cells"][2][3]]["h"], "center")  # 布尔居中

    def test_merge_extends_sparse_grid(self):
        sheet = f'<worksheet {NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row></sheetData><mergeCells><mergeCell ref="A1:D3"/></mergeCells></worksheet>'
        result = xlsx_preview(build(sheet), 0)
        self.assertEqual(result["rows"], [["标题", "", "", ""], ["", "", "", ""], ["", "", "", ""]])
        self.assertEqual(result["grid"]["merges"], [[0, 0, 2, 3]])
        self.assertEqual(result["grid"]["rowHeights"], [0, 0, 0])
        self.assertEqual(len(result["grid"]["cols"]), 4)
        self.assertEqual(result["grid"]["cells"], [[0] * 4 for _ in range(3)])

    def test_merge_respects_preview_limits(self):
        sheet = f'<worksheet {NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row></sheetData><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>'
        result = xlsx_preview(build(sheet), 0)
        self.assertEqual(len(result["rows"]), 120)
        self.assertTrue(all(len(row) == 24 for row in result["rows"]))
        self.assertEqual(result["grid"]["merges"], [[0, 0, 119, 23]])

    def test_hidden_formula_cache_stays_hidden(self):
        styles = f'<styleSheet {NS}><numFmts><numFmt numFmtId="164" formatCode="0;-0;;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'
        for kind, cache, expected in (("", "<v>0</v>", ""), ("", "", "=SUM(B1:C1)"), ("", "<v/>", "=SUM(B1:C1)"), (' t="str"', "<v/>", "")):
            with self.subTest(kind=kind, cache=cache):
                sheet = f'<worksheet {NS}><sheetData><row r="1"><c r="A1" s="1"{kind}><f>SUM(B1:C1)</f>{cache}</c></row></sheetData></worksheet>'
                result = xlsx_preview(build(sheet, styles), 0)
                self.assertEqual(result["rows"], [[expected]])

    def test_plain_workbook_still_works(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("xl/workbook.xml", WORKBOOK)
            archive.writestr("xl/_rels/workbook.xml.rels", RELS)
            archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet {NS}><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>')
        buffer.seek(0)
        result = xlsx_preview(buffer, 0)
        self.assertEqual(result["rows"], [["7"]])
        self.assertTrue(result["grid"]["gridlines"])


if __name__ == "__main__":
    unittest.main()
