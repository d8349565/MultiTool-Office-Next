# -*- coding: utf-8 -*-
"""
Generate realistic, high-quality PDF sample files for OCR testing in office-next.
Uses Microsoft Edge in headless mode to render styled HTML to vector PDFs.
"""

import os
import subprocess
import tempfile

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ocr-samples")

os.makedirs(OUTPUT_DIR, exist_ok=True)

# SVG Red Seal Stamp helper
def make_seal(company_name, title="合同专用章"):
    return f"""
    <div class="seal-container">
        <svg viewBox="0 0 160 160" width="130" height="130" class="official-seal">
            <circle cx="80" cy="80" r="70" stroke="#d93025" stroke-width="3.5" fill="none" opacity="0.85" />
            <circle cx="80" cy="80" r="64" stroke="#d93025" stroke-width="1.2" fill="none" opacity="0.85" />
            <!-- Center Star -->
            <polygon points="80,52 87,70 106,70 91,82 96,100 80,88 64,100 69,82 54,70 73,70" fill="#d93025" opacity="0.85" />
            <!-- Bottom Title -->
            <text x="80" y="125" text-anchor="middle" font-size="14" font-weight="bold" fill="#d93025" letter-spacing="2" opacity="0.85">{title}</text>
            <!-- Circular Top Text (Approximated with SVG textPath) -->
            <path id="curve-{abs(hash(company_name))}" d="M 22,80 A 58,58 0 1,1 138,80" fill="none" />
            <text font-size="12" font-weight="bold" fill="#d93025" opacity="0.85">
                <textPath href="#curve-{abs(hash(company_name))}" startOffset="50%" text-anchor="middle">
                    {company_name}
                </textPath>
            </text>
        </svg>
    </div>
    """

COMMON_STYLE = """
<style>
    @page {
        size: A4 portrait;
        margin: 15mm 18mm;
    }
    * {
        box-sizing: border-box;
    }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "SimSun", sans-serif;
        color: #1f2937;
        margin: 0;
        padding: 0;
        background: #fff;
        line-height: 1.5;
        font-size: 13px;
    }
    .header {
        text-align: center;
        margin-bottom: 24px;
        position: relative;
    }
    .title {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 4px;
        color: #111827;
        margin: 0 0 4px 0;
    }
    .subtitle {
        font-size: 11px;
        letter-spacing: 2px;
        color: #6b7280;
        text-transform: uppercase;
        margin-bottom: 12px;
    }
    .meta-bar {
        display: flex;
        justify-content: space-between;
        border-bottom: 2px solid #111827;
        padding-bottom: 8px;
        font-size: 12px;
        font-weight: 500;
    }
    .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin: 16px 0;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        padding: 12px 16px;
    }
    .field-row {
        margin: 4px 0;
        line-height: 1.6;
    }
    .label {
        color: #4b5563;
        font-weight: 600;
    }
    .value {
        color: #111827;
        font-weight: 500;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
        font-size: 12px;
    }
    th, td {
        border: 1px solid #d1d5db;
        padding: 8px 10px;
        text-align: left;
    }
    th {
        background-color: #f3f4f6;
        color: #374151;
        font-weight: 600;
        text-align: center;
    }
    td.num {
        text-align: right;
    }
    td.center {
        text-align: center;
    }
    .total-row {
        background-color: #fafafa;
        font-weight: 600;
    }
    .clauses {
        margin: 16px 0;
        font-size: 11px;
        color: #4b5563;
        line-height: 1.7;
    }
    .clauses h4 {
        margin: 0 0 4px 0;
        color: #111827;
        font-size: 12px;
    }
    .signatures {
        display: flex;
        justify-content: space-between;
        margin-top: 28px;
        padding-top: 12px;
        position: relative;
    }
    .sign-box {
        width: 46%;
        position: relative;
        line-height: 1.9;
        font-size: 12px;
    }
    .seal-container {
        position: absolute;
        top: -15px;
        right: 15px;
        pointer-events: none;
        transform: rotate(-8deg);
    }
    .barcode-area {
        position: absolute;
        top: 0;
        right: 0;
        text-align: right;
        font-family: monospace;
        font-size: 11px;
        color: #4b5563;
    }
</style>
"""

# 1. 采购合同 HTML
HTML_CONTRACT = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>产品采购合同</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <h1 class="title">产品采购合同</h1>
        <div class="subtitle">STANDARD PURCHASE CONTRACT</div>
        <div class="meta-bar">
            <span>合同编号：<strong>HT-2025-0819</strong></span>
            <span>签订日期：<strong>2025年10月18日</strong></span>
            <span>签订地点：<strong>北京市海淀区</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">需方（买方）：</span><span class="value">北京未来智能科技有限公司</span></div>
            <div class="field-row"><span class="label">统一社会信用代码：</span><span class="value">91110108MA0198KQ88</span></div>
            <div class="field-row"><span class="label">法定代表人：</span><span class="value">陈思远</span></div>
            <div class="field-row"><span class="label">联系地址：</span><span class="value">北京市海淀区中关村南大街1号智谷大厦8层</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">010-82689901</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">供方（卖方）：</span><span class="value">上海卓越晨星电子科技有限公司</span></div>
            <div class="field-row"><span class="label">统一社会信用代码：</span><span class="value">91310115MA1H72XW99</span></div>
            <div class="field-row"><span class="label">法定代表人：</span><span class="value">王振邦</span></div>
            <div class="field-row"><span class="label">联系地址：</span><span class="value">上海市浦东新区张江高科技园区科苑路88号</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">021-50802288</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 40px;">序号</th>
                <th>产品名称</th>
                <th>规格型号</th>
                <th style="width: 50px;">数量</th>
                <th style="width: 50px;">单位</th>
                <th style="width: 90px;">含税单价(元)</th>
                <th style="width: 100px;">含税总金额(元)</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td class="center">1</td>
                <td>边缘智能计算盒子</td>
                <td>AI-BOX-8000 (32G/1T SSD)</td>
                <td class="center">10</td>
                <td class="center">台</td>
                <td class="num">15,000.00</td>
                <td class="num">150,000.00</td>
            </tr>
            <tr>
                <td class="center">2</td>
                <td>工业级广角传感器</td>
                <td>SENS-W200 (IP67防护/千兆网口)</td>
                <td class="center">40</td>
                <td class="center">套</td>
                <td class="num">5,200.00</td>
                <td class="num">208,000.00</td>
            </tr>
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 15px;">合计金额（大写）：人民币叁拾伍万捌仟元整</td>
                <td class="center">合同总额</td>
                <td class="num">￥358,000.00</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>合同条款摘要：</h4>
        <div>1. 交付期限：供方须于合同签订之日起 15 个工作日内将全部货物送达需方指定收货地点。</div>
        <div>2. 质保要求：自验收合格之日起，产品提供 24 个月原厂整机质保及 7×24 小时技术支持响应。</div>
        <div>3. 付款方式：合同签订生效后需方支付 30% 预付款；货物安装调试并出具验收单后 7 个工作日内付清 70% 尾款。</div>
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div><strong>需方（盖章）：北京未来智能科技有限公司</strong></div>
            <div>授权代表签字：陈思远</div>
            <div>开户银行：招商银行北京海淀支行</div>
            <div>银行账号：110908234102901</div>
            <div>签署日期：2025年10月18日</div>
            {make_seal("北京未来智能科技有限公司", "合同专用章")}
        </div>
        <div class="sign-box">
            <div><strong>供方（盖章）：上海卓越晨星电子科技有限公司</strong></div>
            <div>授权代表签字：王振邦</div>
            <div>开户银行：中国工商银行上海张江支行</div>
            <div>银行账号：310066789012345678</div>
            <div>签署日期：2025年10月18日</div>
            {make_seal("上海卓越晨星电子科技有限公司", "合同专用章")}
        </div>
    </div>
</body>
</html>
"""

# 2. 销售出库送货单 HTML
HTML_DELIVERY = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>销售出库送货单</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <div class="barcode-area">
            <div>单据条码：*SH2025110502*</div>
            <div style="font-size: 9px; color: #9ca3af;">仓储物流部专用</div>
        </div>
        <h1 class="title">销售出库送货单</h1>
        <div class="subtitle">DELIVERY ORDER & DISPATCH NOTE</div>
        <div class="meta-bar">
            <span>送货单号：<strong>SH-20251105-02</strong></span>
            <span>送货日期：<strong>2025-11-05</strong></span>
            <span>发货仓库：<strong>华南1号中央仓（深圳）</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">客户名称：</span><span class="value">深圳汇创互联软件有限公司</span></div>
            <div class="field-row"><span class="label">收货人：</span><span class="value">郭海峰</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">0755-88392100</span></div>
            <div class="field-row"><span class="label">送货地址：</span><span class="value">深圳市南山区科技园南区深南科技大厦16层</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">发货单位：</span><span class="value">深圳联创致远智能设备有限公司</span></div>
            <div class="field-row"><span class="label">承运单位：</span><span class="value">顺丰速运（冷链/特快）</span></div>
            <div class="field-row"><span class="label">运单号：</span><span class="value">SF140889271109</span></div>
            <div class="field-row"><span class="label">运输车牌：</span><span class="value">粤B·8K921</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 40px;">序号</th>
                <th style="width: 80px;">物料编码</th>
                <th>产品名称</th>
                <th>规格型号</th>
                <th style="width: 50px;">单位</th>
                <th style="width: 70px;">送货数量</th>
                <th>出厂批号</th>
                <th>备注/检验</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td class="center">1</td>
                <td class="center">M-10294</td>
                <td>高性能微型工控主机</td>
                <td>IPC-Mini-V2 (Intel i7/16G)</td>
                <td class="center">台</td>
                <td class="center" style="font-weight: bold; font-size: 13px;">20</td>
                <td class="center">BAT20251101-A</td>
                <td>原装正品 · 检验合格</td>
            </tr>
            <tr>
                <td class="center">2</td>
                <td class="center">M-10355</td>
                <td>4K超清工业显示器</td>
                <td>DISP-4K-27 (27寸/高亮防眩光)</td>
                <td class="center">台</td>
                <td class="center" style="font-weight: bold; font-size: 13px;">30</td>
                <td class="center">BAT20251028-B</td>
                <td>原装正品 · 检验合格</td>
            </tr>
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 15px;">合计数量（大写）：伍拾台整</td>
                <td class="center" style="font-size: 14px; font-weight: 700; color: #1e40af;">50</td>
                <td colspan="2">包装完好无损，封条完整</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>收货须知与验收声明：</h4>
        <div>1. 请收货单位在收到货物时核对包装、箱数及封条完整性，如有破损或数量差异须当场在回执上注明并拍照取证。</div>
        <div>2. 客户签收即代表本批次送货数量、型号与实物相符。签收联由承运司机带回发货方归档。</div>
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div>发货单位（盖章）：深圳联创致远智能设备有限公司</div>
            <div>制单人：李小萌</div>
            <div>发货仓管：赵伟</div>
            <div>发货时间：2025-11-05 09:30</div>
            {make_seal("深圳联创致远智能设备有限公司", "发货出库专用章")}
        </div>
        <div class="sign-box" style="border: 1px dashed #9ca3af; padding: 10px; border-radius: 4px; background: #fafafa;">
            <div><strong>客户签收确认联（回执）</strong></div>
            <div>客户单位：深圳汇创互联软件有限公司</div>
            <div>收货人签名：___________________</div>
            <div>身份证号后四位：______________</div>
            <div>签收日期：2025年____月____日</div>
        </div>
    </div>
</body>
</html>
"""

# 3. 商务设备报价单 HTML
HTML_QUOTE = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>商务设备报价单</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <div class="barcode-area">
            <div>商机编号：OPP-2025-HZ03</div>
            <div style="font-size: 9px; color: #9ca3af;">版本：V1.2 最终版</div>
        </div>
        <h1 class="title">商务设备报价单</h1>
        <div class="subtitle">COMMERCIAL HARDWARE QUOTATION</div>
        <div class="meta-bar">
            <span>报价单号：<strong>BJ-20251201-09</strong></span>
            <span>报价日期：<strong>2025-12-01</strong></span>
            <span>报价有效期至：<strong>2025-12-31</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">客户单位：</span><span class="value">杭州云端启航数据技术有限公司</span></div>
            <div class="field-row"><span class="label">联系人：</span><span class="value">张建国</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">0571-87991208</span></div>
            <div class="field-row"><span class="label">电子邮箱：</span><span class="value">zhangjg@yunduan-tech.cn</span></div>
            <div class="field-row"><span class="label">项目归属：</span><span class="value">云端数据中心一期网络拓扑扩容</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">报价单位：</span><span class="value">苏州智胜网络通信设备有限公司</span></div>
            <div class="field-row"><span class="label">商务代表：</span><span class="value">林晨风（业务总监）</span></div>
            <div class="field-row"><span class="label">联系手机：</span><span class="value">138-5120-9988</span></div>
            <div class="field-row"><span class="label">公司电话：</span><span class="value">0512-62887711</span></div>
            <div class="field-row"><span class="label">服务承诺：</span><span class="value">原厂三年维保 · 免费送货上门</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 40px;">序号</th>
                <th>项目名称</th>
                <th>品牌 / 规格型号</th>
                <th style="width: 45px;">数量</th>
                <th style="width: 45px;">单位</th>
                <th style="width: 90px;">市场参考价</th>
                <th style="width: 90px;">报价单价(元)</th>
                <th style="width: 100px;">合计金额(元)</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td class="center">1</td>
                <td>企业级万兆核心交换机</td>
                <td>智胜 NET-Core-X10 (48*10G SFP+ / 6*100G QSFP28)</td>
                <td class="center">2</td>
                <td class="center">台</td>
                <td class="num" style="color: #6b7280; text-decoration: line-through;">38,000.00</td>
                <td class="num">32,500.00</td>
                <td class="num">65,000.00</td>
            </tr>
            <tr>
                <td class="center">2</td>
                <td>模块化光纤收发配线架</td>
                <td>智胜 FIBER-MOD-48 (含满配超低损耗LC跳线)</td>
                <td class="center">6</td>
                <td class="center">套</td>
                <td class="num" style="color: #6b7280; text-decoration: line-through;">12,000.00</td>
                <td class="num">10,300.00</td>
                <td class="num">61,800.00</td>
            </tr>
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 15px;">总金额大写：人民币壹拾贰万陆仟捌佰元整（含13%增值税）</td>
                <td colspan="2" class="center">价税合计（元）</td>
                <td class="num" style="font-size: 14px; font-weight: 700; color: #dc2626;">￥126,800.00</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>商务条款及交期说明：</h4>
        <div>1. 价格说明：以上报价包含 13% 增值税专用发票、设备原厂包装及国内主要城市陆运干线物流费。</div>
        <div>2. 供货周期：正式合同签署后 7 个工作日内完成现货备库并安排发出。</div>
        <div>3. 付款条件：合同签署生效后支付 30% 预付款，设备到货初验合格后支付 65%，质保期满一年支付 5% 质保金。</div>
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div><strong>报价单位（盖章）：苏州智胜网络通信设备有限公司</strong></div>
            <div>业务负责人：林晨风</div>
            <div>开户银行：中国建设银行苏州工业园区支行</div>
            <div>银行账号：3220198002341109</div>
            <div>日期：2025年12月01日</div>
            {make_seal("苏州智胜网络通信设备有限公司", "业务报价专用章")}
        </div>
        <div class="sign-box">
            <div><strong>客户确认回执（如同意本报价请签字盖章回传）：</strong></div>
            <div>客户代表确认签字：____________________</div>
            <div>计划下单采购日期：____________________</div>
            <div>客户盖章：</div>
        </div>
    </div>
</body>
</html>
"""

DOCS = [
    ("采购合同_北京未来智能_HT-2025-0819.pdf", HTML_CONTRACT),
    ("销售送货单_深圳汇创互联_SH-20251105-02.pdf", HTML_DELIVERY),
    ("商务报价单_杭州云端启航_BJ-20251201-09.pdf", HTML_QUOTE),
]

for filename, html_content in DOCS:
    pdf_path = os.path.join(OUTPUT_DIR, filename)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".html", delete=False) as f:
        f.write(html_content)
        temp_html = f.name

    cmd = [
        EDGE_PATH,
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        temp_html
    ]
    print(f"Generating {filename}...")
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        os.remove(temp_html)
    except:
        pass

    if os.path.exists(pdf_path):
        size = os.path.getsize(pdf_path)
        print(f" -> Success: {filename} ({size} bytes)", flush=True)
    else:
        print(f" -> Failed to create {filename}", flush=True)
