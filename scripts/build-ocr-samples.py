# -*- coding: utf-8 -*-
"""
Generate realistic, high-quality PDF sample files for OCR testing in office-next.
Generates 30 production-grade sample files across 6 major office document types (5 each):
1. 采购合同 (Purchase Contracts)
2. 销售送货单 (Sales Delivery Orders)
3. 商务报价单 (Commercial Quotations)
4. 财务对账单 (Reconciliation Statements)
5. 工程验收单 (Acceptance Certificates)
6. 增值税发票 (VAT Invoices & Reimbursements)

Uses Microsoft Edge in headless mode to render styled HTML to vector PDFs.
Also outputs matching JSON profile configurations for one-click import into MTO.
"""

import json
import os
import subprocess
import tempfile

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ocr-samples")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# SVG Red Seal Stamp helper
def make_seal(company_name, title="业务专用章"):
    curve_id = f"curve-{abs(hash(company_name + title)) % 1000000}"
    return f"""
    <div class="seal-container">
        <svg viewBox="0 0 160 160" width="130" height="130" class="official-seal">
            <circle cx="80" cy="80" r="70" stroke="#d93025" stroke-width="3.5" fill="none" opacity="0.85" />
            <circle cx="80" cy="80" r="64" stroke="#d93025" stroke-width="1.2" fill="none" opacity="0.85" />
            <polygon points="80,52 87,70 106,70 91,82 96,100 80,88 64,100 69,82 54,70 73,70" fill="#d93025" opacity="0.85" />
            <text x="80" y="125" text-anchor="middle" font-size="14" font-weight="bold" fill="#d93025" letter-spacing="2" opacity="0.85">{title}</text>
            <path id="{curve_id}" d="M 22,80 A 58,58 0 1,1 138,80" fill="none" />
            <text font-size="12" font-weight="bold" fill="#d93025" opacity="0.85">
                <textPath href="#{curve_id}" startOffset="50%" text-anchor="middle">
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
        margin: 14mm 16mm;
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
        margin-bottom: 20px;
        position: relative;
    }
    .title {
        font-size: 23px;
        font-weight: 700;
        letter-spacing: 3px;
        color: #111827;
        margin: 0 0 4px 0;
    }
    .subtitle {
        font-size: 11px;
        letter-spacing: 2px;
        color: #6b7280;
        text-transform: uppercase;
        margin-bottom: 10px;
    }
    .meta-bar {
        display: flex;
        justify-content: space-between;
        border-bottom: 2px solid #111827;
        padding-bottom: 6px;
        font-size: 12px;
        font-weight: 500;
    }
    .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        margin: 14px 0;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        padding: 10px 14px;
    }
    .field-row {
        margin: 3px 0;
        line-height: 1.55;
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
        margin: 14px 0;
        font-size: 12px;
    }
    th, td {
        border: 1px solid #d1d5db;
        padding: 7px 9px;
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
        margin: 14px 0;
        font-size: 11px;
        color: #4b5563;
        line-height: 1.65;
    }
    .clauses h4 {
        margin: 0 0 4px 0;
        color: #111827;
        font-size: 12px;
    }
    .signatures {
        display: flex;
        justify-content: space-between;
        margin-top: 24px;
        padding-top: 10px;
        position: relative;
    }
    .sign-box {
        width: 47%;
        position: relative;
        line-height: 1.85;
        font-size: 12px;
    }
    .seal-container {
        position: absolute;
        top: -12px;
        right: 15px;
        pointer-events: none;
        transform: rotate(-7deg);
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

# HTML Template Builders

def build_contract_html(title, subtitle, code_label, code, date_label, date_val, place,
                        buyer_label, buyer, seller_label, seller,
                        rows, total_cn, total_val, clauses, seal_title="合同专用章"):
    rows_html = ""
    for idx, (pname, spec, qty, unit, price, total) in enumerate(rows, 1):
        rows_html += f"""
        <tr>
            <td class="center">{idx}</td>
            <td>{pname}</td>
            <td>{spec}</td>
            <td class="center">{qty}</td>
            <td class="center">{unit}</td>
            <td class="num">{price}</td>
            <td class="num">{total}</td>
        </tr>
        """
    clauses_html = "".join([f"<div>{i+1}. {c}</div>" for i, c in enumerate(clauses)])
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <h1 class="title">{title}</h1>
        <div class="subtitle">{subtitle}</div>
        <div class="meta-bar">
            <span>{code_label}<strong>{code}</strong></span>
            <span>{date_label}<strong>{date_val}</strong></span>
            <span>签订地点：<strong>{place}</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">{buyer_label}</span><span class="value">{buyer}</span></div>
            <div class="field-row"><span class="label">统一社会信用代码：</span><span class="value">91110108MA0198KQ88</span></div>
            <div class="field-row"><span class="label">法定代表人：</span><span class="value">陈思远</span></div>
            <div class="field-row"><span class="label">联系地址：</span><span class="value">北京市海淀区科技智谷大厦8层</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">010-82689901</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">{seller_label}</span><span class="value">{seller}</span></div>
            <div class="field-row"><span class="label">统一社会信用代码：</span><span class="value">91310115MA1H72XW99</span></div>
            <div class="field-row"><span class="label">法定代表人：</span><span class="value">王振邦</span></div>
            <div class="field-row"><span class="label">联系地址：</span><span class="value">上海市浦东新区张江高科科苑路88号</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">021-50802288</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 36px;">序号</th>
                <th>产品名称</th>
                <th>规格型号</th>
                <th style="width: 45px;">数量</th>
                <th style="width: 45px;">单位</th>
                <th style="width: 85px;">单价(元)</th>
                <th style="width: 95px;">含税总金额(元)</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 12px;">{total_cn}</td>
                <td class="center">合同总额</td>
                <td class="num">{total_val}</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>合同条款摘要：</h4>
        {clauses_html}
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div><strong>需方（盖章）：{buyer}</strong></div>
            <div>授权代表签字：陈思远</div>
            <div>签署日期：{date_val}</div>
            {make_seal(buyer, seal_title)}
        </div>
        <div class="sign-box">
            <div><strong>供方（盖章）：{seller}</strong></div>
            <div>授权代表签字：王振邦</div>
            <div>签署日期：{date_val}</div>
            {make_seal(seller, seal_title)}
        </div>
    </div>
</body>
</html>
"""

def build_delivery_html(title, subtitle, code_label, code, date_label, date_val, warehouse,
                        customer_label, customer, shipper_label, shipper,
                        rows, total_count_cn, total_count_num, clauses, barcode_text=""):
    rows_html = ""
    for idx, (pcode, pname, spec, unit, qty, batch, remark) in enumerate(rows, 1):
        rows_html += f"""
        <tr>
            <td class="center">{idx}</td>
            <td class="center">{pcode}</td>
            <td>{pname}</td>
            <td>{spec}</td>
            <td class="center">{unit}</td>
            <td class="center" style="font-weight: bold;">{qty}</td>
            <td class="center">{batch}</td>
            <td>{remark}</td>
        </tr>
        """
    clauses_html = "".join([f"<div>{i+1}. {c}</div>" for i, c in enumerate(clauses)])
    barcode_area = f'<div class="barcode-area"><div>单据条码：*{barcode_text or code}*</div><div style="font-size: 9px; color: #9ca3af;">仓储物流专联</div></div>'
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        {barcode_area}
        <h1 class="title">{title}</h1>
        <div class="subtitle">{subtitle}</div>
        <div class="meta-bar">
            <span>{code_label}<strong>{code}</strong></span>
            <span>{date_label}<strong>{date_val}</strong></span>
            <span>发货仓库：<strong>{warehouse}</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">{customer_label}</span><span class="value">{customer}</span></div>
            <div class="field-row"><span class="label">收货人：</span><span class="value">郭海峰</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">0755-88392100</span></div>
            <div class="field-row"><span class="label">送货地址：</span><span class="value">深圳市南山区科技园深南科技大厦16层</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">{shipper_label}</span><span class="value">{shipper}</span></div>
            <div class="field-row"><span class="label">承运单位：</span><span class="value">顺丰速运（特快陆运）</span></div>
            <div class="field-row"><span class="label">运单号：</span><span class="value">SF140889271109</span></div>
            <div class="field-row"><span class="label">运输车牌：</span><span class="value">粤B·8K921</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 36px;">序号</th>
                <th style="width: 70px;">物料编码</th>
                <th>产品名称</th>
                <th>规格型号</th>
                <th style="width: 45px;">单位</th>
                <th style="width: 65px;">送货数量</th>
                <th>出厂批号</th>
                <th>检验状态</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 12px;">{total_count_cn}</td>
                <td class="center" style="font-size: 13px; font-weight: 700; color: #1e40af;">{total_count_num}</td>
                <td colspan="2">包装封条完好，原厂正品</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>收货须知与验收声明：</h4>
        {clauses_html}
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div>发货单位（盖章）：{shipper}</div>
            <div>制单仓管：赵伟</div>
            <div>发货日期：{date_val}</div>
            {make_seal(shipper, "发货出库专用章")}
        </div>
        <div class="sign-box" style="border: 1px dashed #9ca3af; padding: 8px 12px; border-radius: 4px; background: #fafafa;">
            <div><strong>客户签收确认联（回执）</strong></div>
            <div>客户单位：{customer}</div>
            <div>收货人签名：___________________</div>
            <div>签收日期：{date_val}</div>
        </div>
    </div>
</body>
</html>
"""

def build_quote_html(title, subtitle, code_label, code, date_label, date_val, expire_val,
                     customer_label, customer, provider_label, provider,
                     rows, total_cn, total_val, clauses, opp_code="OPP-2026-001"):
    rows_html = ""
    for idx, (pname, spec, qty, unit, market_p, quote_p, total_p) in enumerate(rows, 1):
        rows_html += f"""
        <tr>
            <td class="center">{idx}</td>
            <td>{pname}</td>
            <td>{spec}</td>
            <td class="center">{qty}</td>
            <td class="center">{unit}</td>
            <td class="num" style="color: #6b7280; text-decoration: line-through;">{market_p}</td>
            <td class="num">{quote_p}</td>
            <td class="num">{total_p}</td>
        </tr>
        """
    clauses_html = "".join([f"<div>{i+1}. {c}</div>" for i, c in enumerate(clauses)])
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <div class="barcode-area">
            <div>商机编号：{opp_code}</div>
            <div style="font-size: 9px; color: #9ca3af;">版本：V1.2 最终版</div>
        </div>
        <h1 class="title">{title}</h1>
        <div class="subtitle">{subtitle}</div>
        <div class="meta-bar">
            <span>{code_label}<strong>{code}</strong></span>
            <span>{date_label}<strong>{date_val}</strong></span>
            <span>报价有效期至：<strong>{expire_val}</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">{customer_label}</span><span class="value">{customer}</span></div>
            <div class="field-row"><span class="label">联系人：</span><span class="value">张建国</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">0571-87991208</span></div>
            <div class="field-row"><span class="label">电子邮箱：</span><span class="value">zhangjg@customer-tech.cn</span></div>
            <div class="field-row"><span class="label">项目归属：</span><span class="value">数据中心一期拓扑升级扩容</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">{provider_label}</span><span class="value">{provider}</span></div>
            <div class="field-row"><span class="label">商务代表：</span><span class="value">林晨风（业务总监）</span></div>
            <div class="field-row"><span class="label">联系手机：</span><span class="value">138-5120-9988</span></div>
            <div class="field-row"><span class="label">公司电话：</span><span class="value">0512-62887711</span></div>
            <div class="field-row"><span class="label">服务承诺：</span><span class="value">原厂三年维保 · 免费送货上门</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 36px;">序号</th>
                <th>项目名称</th>
                <th>规格型号</th>
                <th style="width: 40px;">数量</th>
                <th style="width: 40px;">单位</th>
                <th style="width: 80px;">市场参考价</th>
                <th style="width: 80px;">报价单价(元)</th>
                <th style="width: 95px;">合计金额(元)</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 12px;">{total_cn}</td>
                <td colspan="2" class="center">价税合计（元）</td>
                <td class="num" style="font-size: 13px; font-weight: 700; color: #dc2626;">{total_val}</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>商务条款及交期说明：</h4>
        {clauses_html}
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div><strong>报价单位（盖章）：{provider}</strong></div>
            <div>业务负责人：林晨风</div>
            <div>报价出具日期：{date_val}</div>
            {make_seal(provider, "业务报价专用章")}
        </div>
        <div class="sign-box">
            <div><strong>客户确认回执（同意请签字盖章回传）：</strong></div>
            <div>客户代表确认签字：____________________</div>
            <div>计划下单采购日期：____________________</div>
        </div>
    </div>
</body>
</html>
"""

def build_reconciliation_html(title, subtitle, code_label, code, date_label, date_val, period,
                              customer_label, customer, accountant_label, accountant,
                              rows, total_cn, total_val, clauses):
    rows_html = ""
    for idx, (bdate, bcode, bdesc, curr, debit, credit, bal) in enumerate(rows, 1):
        rows_html += f"""
        <tr>
            <td class="center">{idx}</td>
            <td class="center">{bdate}</td>
            <td class="center">{bcode}</td>
            <td>{bdesc}</td>
            <td class="center">{curr}</td>
            <td class="num">{debit}</td>
            <td class="num">{credit}</td>
            <td class="num">{bal}</td>
        </tr>
        """
    clauses_html = "".join([f"<div>{i+1}. {c}</div>" for i, c in enumerate(clauses)])
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <h1 class="title">{title}</h1>
        <div class="subtitle">{subtitle}</div>
        <div class="meta-bar">
            <span>{code_label}<strong>{code}</strong></span>
            <span>对账期间：<strong>{period}</strong></span>
            <span>{date_label}<strong>{date_val}</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">{customer_label}</span><span class="value">{customer}</span></div>
            <div class="field-row"><span class="label">财务联系人：</span><span class="value">李晓梅（应付会计）</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">0571-88155188</span></div>
            <div class="field-row"><span class="label">开户银行：</span><span class="value">招商银行杭州高新支行</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">{accountant_label}</span><span class="value">{accountant}</span></div>
            <div class="field-row"><span class="label">核算财务：</span><span class="value">王晓敏</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">010-88220199</span></div>
            <div class="field-row"><span class="label">对账币种：</span><span class="value">人民币 (CNY)</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 36px;">序号</th>
                <th style="width: 75px;">业务日期</th>
                <th style="width: 90px;">单据编号</th>
                <th>业务摘要</th>
                <th style="width: 40px;">币种</th>
                <th style="width: 75px;">借方金额</th>
                <th style="width: 75px;">贷方金额</th>
                <th style="width: 80px;">结存余额</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
            <tr class="total-row">
                <td colspan="5" style="text-align: right; padding-right: 12px;">{total_cn}</td>
                <td colspan="2" class="center">结算金额合计</td>
                <td class="num" style="font-size: 13px; font-weight: 700; color: #dc2626;">{total_val}</td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>财务对账说明与异议期条款：</h4>
        {clauses_html}
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div><strong>核算单位（盖章）：{accountant}</strong></div>
            <div>财务主管审核：王晓敏</div>
            <div>对账出具日期：{date_val}</div>
            {make_seal(accountant, "财务结算专用章")}
        </div>
        <div class="sign-box">
            <div><strong>客户单位确认（盖章）：{customer}</strong></div>
            <div>核对无误签字：____________________</div>
            <div>确认签署日期：{date_val}</div>
            {make_seal(customer, "财务对账专用章")}
        </div>
    </div>
</body>
</html>
"""

def build_acceptance_html(title, subtitle, code_label, code, date_label, date_val, project,
                          client_label, client, contractor_label, contractor,
                          rows, conclusion, clauses):
    rows_html = ""
    for idx, (iname, ispec, iqty, iunit, iresult, iremark) in enumerate(rows, 1):
        rows_html += f"""
        <tr>
            <td class="center">{idx}</td>
            <td>{iname}</td>
            <td>{ispec}</td>
            <td class="center">{iqty}</td>
            <td class="center">{iunit}</td>
            <td class="center" style="font-weight: bold; color: #047857;">{iresult}</td>
            <td>{iremark}</td>
        </tr>
        """
    clauses_html = "".join([f"<div>{i+1}. {c}</div>" for i, c in enumerate(clauses)])
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <h1 class="title">{title}</h1>
        <div class="subtitle">{subtitle}</div>
        <div class="meta-bar">
            <span>{code_label}<strong>{code}</strong></span>
            <span>项目名称：<strong>{project}</strong></span>
            <span>{date_label}<strong>{date_val}</strong></span>
        </div>
    </div>

    <div class="grid-2">
        <div>
            <div class="field-row"><span class="label">{client_label}</span><span class="value">{client}</span></div>
            <div class="field-row"><span class="label">项目负责人：</span><span class="value">宋文涛</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">021-68892100</span></div>
            <div class="field-row"><span class="label">建设地址：</span><span class="value">上海市浦东新区陆家嘴金融大厦20层</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">{contractor_label}</span><span class="value">{contractor}</span></div>
            <div class="field-row"><span class="label">承建项目经理：</span><span class="value">周浩</span></div>
            <div class="field-row"><span class="label">联系电话：</span><span class="value">0551-65338199</span></div>
            <div class="field-row"><span class="label">质保期限：</span><span class="value">自验收合格之日起 24 个月</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 36px;">序号</th>
                <th>已验收设备 / 交付分项</th>
                <th>规格指标要求</th>
                <th style="width: 45px;">数量</th>
                <th style="width: 45px;">单位</th>
                <th style="width: 70px;">检验结果</th>
                <th>核对说明</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
            <tr class="total-row">
                <td colspan="7" style="padding: 10px 14px; font-size: 13px;">
                    <strong>验收结论：</strong>{conclusion}
                </td>
            </tr>
        </tbody>
    </table>

    <div class="clauses">
        <h4>验收后续维保约定：</h4>
        {clauses_html}
    </div>

    <div class="signatures">
        <div class="sign-box">
            <div><strong>建设单位（盖章）：{client}</strong></div>
            <div>业主代表签字：宋文涛</div>
            <div>验收签署日期：{date_val}</div>
            {make_seal(client, "工程验收专用章")}
        </div>
        <div class="sign-box">
            <div><strong>承建单位（盖章）：{contractor}</strong></div>
            <div>项目经理签字：周浩</div>
            <div>竣工交付日期：{date_val}</div>
            {make_seal(contractor, "工程项目专用章")}
        </div>
    </div>
</body>
</html>
"""

def build_invoice_html(title, inv_code, inv_num, date_label, date_val,
                       buyer_label, buyer, buyer_tax,
                       seller_label, seller, seller_tax,
                       rows, total_cn, total_val):
    rows_html = ""
    for pname, spec, unit, qty, price, amount, rate, tax in rows:
        rows_html += f"""
        <tr>
            <td>{pname}</td>
            <td class="center">{spec}</td>
            <td class="center">{unit}</td>
            <td class="center">{qty}</td>
            <td class="num">{price}</td>
            <td class="num">{amount}</td>
            <td class="center">{rate}</td>
            <td class="num">{tax}</td>
        </tr>
        """
    code_span = f"<span>发票代码：<strong>{inv_code}</strong></span>" if inv_code else ""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    {COMMON_STYLE}
</head>
<body>
    <div class="header">
        <h1 class="title" style="color: #991b1b; letter-spacing: 5px;">{title}</h1>
        <div class="meta-bar" style="border-bottom: 2px solid #991b1b;">
            {code_span}
            <span>发票号码：<strong>{inv_num}</strong></span>
            <span>{date_label}<strong>{date_val}</strong></span>
        </div>
    </div>

    <div class="grid-2" style="background: #fffcf8; border-color: #fed7aa;">
        <div>
            <div class="field-row"><span class="label">{buyer_label}</span><span class="value">{buyer}</span></div>
            <div class="field-row"><span class="label">统一信用代码：</span><span class="value">{buyer_tax}</span></div>
            <div class="field-row"><span class="label">地址、电话：</span><span class="value">北京市海淀区中关村南大街1号 010-88291001</span></div>
            <div class="field-row"><span class="label">开户行及账号：</span><span class="value">招商银行北京分行 110908234102901</span></div>
        </div>
        <div>
            <div class="field-row"><span class="label">{seller_label}</span><span class="value">{seller}</span></div>
            <div class="field-row"><span class="label">统一信用代码：</span><span class="value">{seller_tax}</span></div>
            <div class="field-row"><span class="label">地址、电话：</span><span class="value">上海市浦东新区张江科苑路88号 021-50802288</span></div>
            <div class="field-row"><span class="label">开户行及账号：</span><span class="value">中国工商银行上海张江支行 310066789012345678</span></div>
        </div>
    </div>

    <table>
        <thead>
            <tr style="background: #ffedd5;">
                <th>货物或应税劳务、服务名称</th>
                <th style="width: 75px;">规格型号</th>
                <th style="width: 40px;">单位</th>
                <th style="width: 45px;">数量</th>
                <th style="width: 75px;">单价(不含税)</th>
                <th style="width: 80px;">金额(元)</th>
                <th style="width: 45px;">税率</th>
                <th style="width: 70px;">税额(元)</th>
            </tr>
        </thead>
        <tbody>
            {rows_html}
            <tr class="total-row" style="background: #fff7ed;">
                <td colspan="4" style="text-align: right; padding-right: 12px;">价税合计（大写）：{total_cn}</td>
                <td colspan="2" class="center">价税合计（小写）</td>
                <td colspan="2" class="num" style="font-size: 14px; font-weight: 700; color: #991b1b;">{total_val}</td>
            </tr>
        </tbody>
    </table>

    <div class="signatures" style="margin-top: 18px;">
        <div class="sign-box">
            <div>收款人：赵晨 &nbsp;&nbsp;&nbsp;&nbsp; 复核：李青 &nbsp;&nbsp;&nbsp;&nbsp; 开票人：张静</div>
            <div style="margin-top: 6px; font-size: 11px; color: #6b7280;">注：本发票为系统自动开具，防伪数码与税务发票底账库一致。</div>
        </div>
        <div class="sign-box">
            <div style="text-align: right; padding-right: 30px;"><strong>销售方（发票监制章）</strong></div>
            {make_seal(seller, "发票专用章")}
        </div>
    </div>
</body>
</html>
"""

# OCR Profile Definitions (Strictly validated according to Rust validate rules)

PROFILES = {
    "purchase-contract": {
        "id": "purchase-contract",
        "name": "采购合同",
        "keywords": ["采购合同", "合同编号", "标准采购", "PURCHASE CONTRACT", "协议"],
        "pages": "1",
        "dpi": 200,
        "fields": [
            {
                "key": "合同编号",
                "prompt": "提取采购合同的唯一编号，通常以 HT、SW、BC、CG 开头",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["合同编号：", "合同编号", "协议编号：", "补充协议号：", "编号："],
                "pattern": r"(?:HT|SW|BC|CG)-[A-Za-z0-9\-]+|[A-Za-z0-9][A-Za-z0-9\-_/]{3,39}",
                "stripPrefixes": ["合同编号：", "合同编号:", "协议编号：", "协议编号:", "补充协议号：", "编号：", "：", ":"],
                "format": ""
            },
            {
                "key": "需方名称",
                "prompt": "选择买方、采购方、需方的企业全称，严格排除供方和卖方",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["需方（买方）：", "需方名称：", "需方：", "买方：", "甲方(采购人)：", "买方单位：", "买方名称："],
                "pattern": "",
                "stripPrefixes": ["需方（买方）：", "需方（买方）:", "需方名称：", "需方名称:", "需方：", "需方:", "买方：", "买方:", "甲方(采购人)：", "买方单位：", "：", ":"],
                "format": ""
            },
            {
                "key": "签订日期",
                "prompt": "提取合同正式签订或签署日期，格式通常为年月日",
                "kind": "date",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["签订日期：", "签订日期", "签约日期：", "签署日期：", "签约时间：", "合同签订于："],
                "pattern": "",
                "stripPrefixes": ["签订日期：", "签订日期:", "签约日期：", "签约日期:", "签署日期：", "签约时间：", "合同签订于：", "：", ":"],
                "format": "%Y%m%d"
            },
            {
                "key": "合同金额",
                "prompt": "提取采购合同的总金额或价税合计数值，排除单价与数量",
                "kind": "number",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["合同总额", "合计金额", "总金额", "价税合计", "本次增补金额", "合同含税总价"],
                "pattern": "",
                "stripPrefixes": ["￥", "$", "合同总额：", "合计金额：", "：", ":"],
                "format": "2"
            }
        ],
        "filenamePattern": "{签订日期}_{需方名称}_{合同编号}",
        "threshold": 0.75,
        "extraTitles": ["产品采购合同", "软件采购框架协议"],
        "noiseMarkers": ["统一社会信用代码", "法定代表人"],
        "extraHeaders": []
    },
    "delivery-order": {
        "id": "delivery-order",
        "name": "销售送货单",
        "keywords": ["送货单", "出库送货单", "DELIVERY", "送货", "出库交接单", "送货清单"],
        "pages": "1",
        "dpi": 200,
        "fields": [
            {
                "key": "送货单号",
                "prompt": "提取销售送货单的单据编号，通常以 SH 开头",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["送货单号：", "送货单号", "单号：", "送货单编号：", "单据条码："],
                "pattern": r"(?:SH|KD)-[A-Za-z0-9\-]+|[A-Za-z0-9][A-Za-z0-9\-_]{3,39}",
                "stripPrefixes": ["送货单号：", "送货单号:", "单号：", "单号:", "送货单编号：", "单据条码：", "*", "：", ":"],
                "format": ""
            },
            {
                "key": "客户名称",
                "prompt": "提取收货方、买方或客户企业名称，排除发货单位",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["客户名称：", "客户名称", "收货单位：", "客户：", "收货客户：", "工程项目客户："],
                "pattern": "",
                "stripPrefixes": ["客户名称：", "客户名称:", "收货单位：", "收货单位:", "客户：", "客户:", "收货客户：", "工程项目客户：", "：", ":"],
                "format": ""
            },
            {
                "key": "送货日期",
                "prompt": "提取本次出库送货的具体日期",
                "kind": "date",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["送货日期：", "送货日期", "发货日期：", "出库日期：", "发货时间：", "送达日期："],
                "pattern": "",
                "stripPrefixes": ["送货日期：", "送货日期:", "发货日期：", "出库日期：", "发货时间：", "送达日期：", "：", ":"],
                "format": "%Y%m%d"
            },
            {
                "key": "产品名称",
                "prompt": "提取明细表格中的送货产品或物料名称，排除规格型号与数量",
                "kind": "text",
                "multiple": True,
                "maxItems": 5,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["产品名称", "物料名称", "货物名称", "品名", "主要药品"],
                "pattern": "",
                "stripPrefixes": [],
                "format": ""
            },
            {
                "key": "送货数量",
                "prompt": "提取送货总数量合计",
                "kind": "number",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": False,
                "fallback": "",
                "anchors": ["合计数量", "总数量", "发货件数", "送货数量"],
                "pattern": "",
                "stripPrefixes": [],
                "format": "0"
            }
        ],
        "filenamePattern": "{送货日期}_{客户名称}_{送货单号}",
        "threshold": 0.75,
        "extraTitles": ["销售出库送货单", "仓储物流出库交接单"],
        "noiseMarkers": ["仓储物流专联", "条码"],
        "extraHeaders": []
    },
    "quotation-sheet": {
        "id": "quotation-sheet",
        "name": "商务报价单",
        "keywords": ["报价单", "Quotation", "COMMERCIAL", "报价", "报价清单"],
        "pages": "1",
        "dpi": 200,
        "fields": [
            {
                "key": "报价单号",
                "prompt": "提取商务报价单的报价编号，通常以 BJ 开头",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["报价单号：", "报价单号", "报价编号：", "单据编号："],
                "pattern": r"BJ-[A-Za-z0-9\-]+|[A-Za-z0-9][A-Za-z0-9\-_]{3,39}",
                "stripPrefixes": ["报价单号：", "报价单号:", "报价编号：", "单据编号：", "：", ":"],
                "format": ""
            },
            {
                "key": "客户单位",
                "prompt": "提取询价方、客户单位全称，严格排除报价单位与供应商",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["客户单位：", "客户单位", "客户名称：", "询价客户：", "买方客户：", "客户："],
                "pattern": "",
                "stripPrefixes": ["客户单位：", "客户单位:", "客户名称：", "询价客户：", "买方客户：", "客户：", "：", ":"],
                "format": ""
            },
            {
                "key": "报价日期",
                "prompt": "提取报价出具日期，严格排除有效期至与截止日期",
                "kind": "date",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["报价日期：", "报价日期", "制单日期：", "出具日期：", "制单时间：", "日期："],
                "pattern": "",
                "stripPrefixes": ["报价日期：", "报价日期:", "制单日期：", "出具日期：", "制单时间：", "日期：", "：", ":"],
                "format": "%Y%m%d"
            },
            {
                "key": "价税合计",
                "prompt": "提取报价单的最终含税总金额或价税合计，排除单价与参考价",
                "kind": "number",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["价税合计", "总金额", "合计金额", "报价总额", "整线含税总报价", "优惠折后价税合计", "年维保总金额"],
                "pattern": "",
                "stripPrefixes": ["￥", "$", "价税合计：", "：", ":"],
                "format": "2"
            }
        ],
        "filenamePattern": "{报价日期}_{客户单位}_{报价单号}",
        "threshold": 0.75,
        "extraTitles": ["商务设备报价单", "商务报价清单"],
        "noiseMarkers": ["商机编号", "版本：", "市场参考"],
        "extraHeaders": []
    },
    "reconciliation-statement": {
        "id": "reconciliation-statement",
        "name": "财务对账单",
        "keywords": ["对账单", "结算对账单", "月结对账", "结算清单", "往来账款"],
        "pages": "1",
        "dpi": 200,
        "fields": [
            {
                "key": "对账单号",
                "prompt": "提取财务对账单或结算单编号，通常以 DZ、GYS、WL、JS 开头",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["对账单号：", "对账单号", "单据编号：", "结算单号：", "结算单据号："],
                "pattern": r"(?:DZ|GYS|WL|JS)-[A-Za-z0-9\-]+|[A-Za-z0-9][A-Za-z0-9\-_]{3,39}",
                "stripPrefixes": ["对账单号：", "单据编号：", "结算单号：", "结算单据号：", "：", ":"],
                "format": ""
            },
            {
                "key": "客户名称",
                "prompt": "提取合作客户、商户或供应商名称，排除出具对账方",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["客户名称：", "合作供应商：", "托运客户：", "商户名称：", "客户："],
                "pattern": "",
                "stripPrefixes": ["客户名称：", "合作供应商：", "托运客户：", "商户名称：", "客户：", "：", ":"],
                "format": ""
            },
            {
                "key": "对账日期",
                "prompt": "提取对账正式确认日期或出具日期",
                "kind": "date",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["对账确认日期：", "确认签署日期：", "制表日期：", "结算出具日：", "确认日期：", "对账日期："],
                "pattern": "",
                "stripPrefixes": ["对账确认日期：", "确认签署日期：", "制表日期：", "结算出具日：", "确认日期：", "对账日期：", "：", ":"],
                "format": "%Y%m%d"
            },
            {
                "key": "结算金额",
                "prompt": "提取本期应收或实际应付结算金额总计",
                "kind": "number",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["本期应收账款总额", "价税合计应付", "累计应结运费", "实付代销净额", "结算金额合计", "结算总额"],
                "pattern": "",
                "stripPrefixes": ["￥", "$", "：", ":"],
                "format": "2"
            }
        ],
        "filenamePattern": "{对账日期}_{客户名称}_{对账单号}",
        "threshold": 0.75,
        "extraTitles": ["客户往来账款结算对账单", "供应商应付货款月结对账确认函"],
        "noiseMarkers": ["对账期间", "开户银行"],
        "extraHeaders": []
    },
    "acceptance-certificate": {
        "id": "acceptance-certificate",
        "name": "工程验收单",
        "keywords": ["验收单", "验收合格报告", "验收证明书", "验收交接书", "检验合格报告", "验收报告"],
        "pages": "1",
        "dpi": 200,
        "fields": [
            {
                "key": "验收编号",
                "prompt": "提取工程验收单号或检验报告编号，通常以 YS 开头",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["验收编号：", "验收编号", "单据编号：", "验收单号：", "验收案号：", "报告号："],
                "pattern": r"YS-[A-Za-z0-9\-_/（）()\u4e00-\u9fa5]+|[A-Za-z0-9][A-Za-z0-9\-_/]{3,39}",
                "stripPrefixes": ["验收编号：", "单据编号：", "验收单号：", "验收案号：", "报告号：", "：", ":"],
                "format": ""
            },
            {
                "key": "客户名称",
                "prompt": "提取建设单位、业主、使用客户或收货单位全称",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["建设单位（业主）：", "建设单位：", "使用客户：", "医疗机构单位：", "收货单位：", "客户："],
                "pattern": "",
                "stripPrefixes": ["建设单位（业主）：", "建设单位：", "使用客户：", "医疗机构单位：", "收货单位：", "客户：", "：", ":"],
                "format": ""
            },
            {
                "key": "验收日期",
                "prompt": "提取验收合格或签署通过的日期",
                "kind": "date",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["验收评审通过日期：", "初验日期：", "签字验收日期：", "勘验日期：", "验收日期：", "通过日期："],
                "pattern": "",
                "stripPrefixes": ["验收评审通过日期：", "初验日期：", "签字验收日期：", "勘验日期：", "验收日期：", "通过日期：", "：", ":"],
                "format": "%Y%m%d"
            },
            {
                "key": "产品名称",
                "prompt": "提取已验收设备、系统模块或交付项目名称",
                "kind": "text",
                "multiple": True,
                "maxItems": 5,
                "separator": "、",
                "required": False,
                "fallback": "",
                "anchors": ["已验收设备", "设备名称", "项目名称", "交付分项"],
                "pattern": "",
                "stripPrefixes": [],
                "format": ""
            }
        ],
        "filenamePattern": "{验收日期}_{客户名称}_{验收编号}",
        "threshold": 0.75,
        "extraTitles": ["信息化系统建设工程最终验收合格报告", "初步验收交接书"],
        "noiseMarkers": ["验收结论", "质保期限"],
        "extraHeaders": []
    },
    "vat-invoice": {
        "id": "vat-invoice",
        "name": "增值税发票",
        "keywords": ["发票", "普通发票", "专用发票", "电子发票", "行程报销单", "增值税"],
        "pages": "1",
        "dpi": 200,
        "fields": [
            {
                "key": "发票号码",
                "prompt": "提取8位普通发票号码、20位数电发票号码或行程单号",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["发票号码：", "发票号码", "行程单号：", "No."],
                "pattern": r"\d{20}|\d{8}|DD-[A-Za-z0-9\-]+|[A-Za-z0-9\-_]{8,24}",
                "stripPrefixes": ["发票号码：", "发票号码:", "行程单号：", "No.", "NO.", "：", ":"],
                "format": ""
            },
            {
                "key": "买方名称",
                "prompt": "提取购买方企业全称或个人姓名，严格排除销售方",
                "kind": "text",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["购买方名称：", "购买方名称及身份证号码/组织机构代码：", "申请人/企业客户：", "购买方："],
                "pattern": "",
                "stripPrefixes": ["购买方名称：", "购买方名称及身份证号码/组织机构代码：", "申请人/企业客户：", "购买方：", "：", ":"],
                "format": ""
            },
            {
                "key": "开票日期",
                "prompt": "提取发票正式开具日期",
                "kind": "date",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["开票日期：", "开票日期", "申请日期："],
                "pattern": "",
                "stripPrefixes": ["开票日期：", "开票日期:", "申请日期：", "：", ":"],
                "format": "%Y%m%d"
            },
            {
                "key": "发票金额",
                "prompt": "提取发票最终含税价税合计金额",
                "kind": "number",
                "multiple": False,
                "maxItems": 1,
                "separator": "、",
                "required": True,
                "fallback": "",
                "anchors": ["价税合计（小写）", "金额合计", "价税合计"],
                "pattern": "",
                "stripPrefixes": ["￥", "$", "：", ":"],
                "format": "2"
            }
        ],
        "filenamePattern": "{开票日期}_{买方名称}_{发票号码}",
        "threshold": 0.75,
        "extraTitles": ["增值税电子普通发票", "电子发票（增值税专用发票）"],
        "noiseMarkers": ["统一信用代码", "销售方"],
        "extraHeaders": []
    }
}

# 30 Detailed Cases Data

ALL_CASES = [
    # --- 类型一：采购合同 (5份) ---
    (
        "01_采购合同_北京未来智能_HT-2026-0819.pdf",
        build_contract_html(
            title="产品采购合同", subtitle="STANDARD PURCHASE CONTRACT",
            code_label="合同编号：", code="HT-2026-0819",
            date_label="签订日期：", date_val="2026年10月18日", place="北京市海淀区",
            buyer_label="需方（买方）：", buyer="北京未来智能科技有限公司",
            seller_label="供方（卖方）：", seller="上海卓越晨星电子科技有限公司",
            rows=[
                ("边缘智能计算盒子", "AI-BOX-8000 (32G/1T SSD)", "10", "台", "15,000.00", "150,000.00"),
                ("工业级广角传感器", "SENS-W200 (IP67防护/千兆网口)", "40", "套", "5,200.00", "208,000.00")
            ],
            total_cn="合计金额（大写）：人民币叁拾伍万捌仟元整", total_val="￥358,000.00",
            clauses=["供方须于合同签订之日起 15 个工作日内送达指定地点。", "整机原厂质保 24 个月及 7×24 技术响应。", "合同生效后付 30% 预付款；初验合格付清 70% 尾款。"]
        )
    ),
    (
        "02_采购协议_深圳腾跃数智_SW-2026-X091.pdf",
        build_contract_html(
            title="软件采购框架协议", subtitle="SOFTWARE PURCHASE FRAMEWORK AGREEMENT",
            code_label="协议编号：", code="SW-2026-X091",
            date_label="签署日期：", date_val="2026年10月19日", place="深圳市南山区",
            buyer_label="甲方(采购人)：", buyer="深圳腾跃数智信息科技有限公司",
            seller_label="乙方(服务商)：", seller="杭州云拓网络服务有限公司",
            rows=[
                ("企业级工作流引擎套件", "Enterprise Edition V5.0", "1", "套", "180,000.00", "180,000.00"),
                ("专属技术支持与定制开发", "年度专家技术支持人月", "2", "人月", "45,000.00", "90,000.00")
            ],
            total_cn="合计金额（大写）：人民币贰拾柒万元整", total_val="￥270,000.00",
            clauses=["乙方按约定向甲方交付平台部署密钥及源码授权。", "技术支持期自验收签字之日起满 12 个月。", "本框架协议有效期自 2026年10月19日至 2027年10月18日止。"]
        )
    ),
    (
        "03_补充协议_广州华誉商业_BC-2026-003.pdf",
        build_contract_html(
            title="办公家具定制采购补充协议书", subtitle="SUPPLEMENTARY PURCHASE AGREEMENT",
            code_label="补充协议号：", code="BC-2026-003",
            date_label="签约时间：", date_val="2026年03月15日", place="广州市天河区",
            buyer_label="买方单位：", buyer="广州华誉商业咨询管理有限公司",
            seller_label="卖方单位：", seller="佛山美邦家具有限公司",
            rows=[
                ("人体工学办公网椅", "Ergo-Pro 黑框静音轮", "30", "把", "850.00", "25,500.00"),
                ("升降式双人办公工位", "Desk-Dual-1400 电动升降", "6", "套", "3,500.00", "21,000.00")
            ],
            total_cn="本次增补金额（大写）：人民币肆万陆仟伍佰元整", total_val="￥46,500.00",
            clauses=["本协议为原主合同 HT-2025-1102 之补充，条款与原合同具备同等效力。", "所有增补家具须于 2026年03月30日前进场并完成组装验收。"]
        )
    ),
    (
        "04_采购合同_无锡新锐特种金属_CG-202604-088.pdf",
        build_contract_html(
            title="工业钢材采购合同", subtitle="INDUSTRIAL STEEL PURCHASE CONTRACT",
            code_label="编号：", code="CG-202604-088",
            date_label="合同签订于：", date_val="2026年04月20日", place="无锡市新吴区",
            buyer_label="需方：", buyer="无锡新锐特种金属制造有限公司",
            seller_label="供方：", seller="江苏冶金实业集团有限公司",
            rows=[
                ("高精度冷轧不锈钢卷", "SUS304-2B (厚度1.5mm)", "20", "吨", "32,000.00", "640,000.00"),
                ("航空级耐蚀钛合金板", "TC4-GR5 (厚度8.0mm)", "4", "吨", "160,000.00", "640,000.00")
            ],
            total_cn="合同含税总价（大写）：人民币壹佰贰拾捌万元整", total_val="￥1,280,000.00",
            clauses=["原材料随货附带原厂材质检验分析证明书（MTC）。", "运输方式为汽运直达需方一号车间，运费由供方承担。"]
        )
    ),
    (
        "05_采购合同附件_北京未来智能_HT-2026-0819.pdf",
        build_contract_html(
            title="产品采购合同附件一（技术规范）", subtitle="CONTRACT APPENDIX & SPECIFICATION",
            code_label="合同编号：", code="HT-2026-0819",
            date_label="签订日期：", date_val="2026年10月18日", place="北京市海淀区",
            buyer_label="需方（买方）：", buyer="北京未来智能科技有限公司",
            seller_label="供方（卖方）：", seller="上海卓越晨星电子科技有限公司",
            rows=[
                ("配套光电隔离转换模块", "OPT-ISO-100", "10", "套", "800.00", "8,000.00"),
                ("备用防爆航插线束", "CBL-EX-10M", "20", "根", "350.00", "7,000.00")
            ],
            total_cn="附件金额（大写）：人民币壹万伍仟元整", total_val="￥15,000.00",
            clauses=["本附件为合同 HT-2026-0819 不可分割之组成部分，重名文件用于预检序号递增测试。"]
        )
    ),

    # --- 类型二：销售送货单 (5份) ---
    (
        "06_销售送货单_深圳汇创互联_SH-20261016-01.pdf",
        build_delivery_html(
            title="销售出库送货单", subtitle="DELIVERY ORDER & DISPATCH NOTE",
            code_label="送货单号：", code="SH-20261016-01",
            date_label="送货日期：", date_val="2026-10-16", warehouse="华南1号中央仓（深圳）",
            customer_label="客户名称：", customer="深圳汇创互联软件有限公司",
            shipper_label="发货单位：", shipper="深圳联创致远智能设备有限公司",
            rows=[
                ("M-10294", "高性能微型工控主机", "IPC-Mini-V2 (Intel i7/16G)", "台", "20", "BAT20261001-A", "检验合格"),
                ("M-10355", "4K超清工业显示器", "DISP-4K-27 (27寸/高亮防眩光)", "台", "30", "BAT20260928-B", "检验合格")
            ],
            total_count_cn="合计数量（大写）：伍拾台整", total_count_num="50",
            clauses=["收货时请核对箱数、外包装封条是否完整。", "签收即视为产品外观与数量无误，回执联由承运司机带回。"]
        )
    ),
    (
        "07_仓储出库交接单_武汉楚天极光_SH-20260901-88.pdf",
        build_delivery_html(
            title="仓储物流出库交接单", subtitle="WAREHOUSE DISPATCH HANDOVER VOUCHER",
            code_label="送货单号：", code="SH-20260901-88",
            date_label="出库日期：", date_val="2026年09月01日", warehouse="华中光电产业园配送中心",
            customer_label="收货单位：", customer="武汉楚天极光光电技术有限公司",
            shipper_label="发货单位：", shipper="武汉长飞精密仪器设备有限公司",
            rows=[
                ("OP-8801", "激光准直镜头模组", "LENS-COLL-500 (镀增透膜)", "套", "120", "LOT20260830", "精密光学包装")
            ],
            total_count_cn="发货件数（大写）：壹佰贰拾套整", total_count_num="120",
            clauses=["精密光学元件，装卸请轻拿轻放，严禁倒置挤压。"],
            barcode_text="SH-20260901-88"
        )
    ),
    (
        "08_工程物资送货单_中建八局南京_SH-20261005-03.pdf",
        build_delivery_html(
            title="工程物资送货单", subtitle="CONSTRUCTION MATERIAL DISPATCH ORDER",
            code_label="单号：", code="SH-20261005-03",
            date_label="送货日期：", date_val="2026-10-05", warehouse="江宁建材大型直配仓",
            customer_label="工程项目客户：", customer="中建八局南京智慧城项目部",
            shipper_label="发货单位：", shipper="江苏长江新型建材实业有限公司",
            rows=[
                ("JC-501", "通用硅酸盐水泥", "P.O 42.5 (袋装50kg)", "吨", "30", "PH20261004", "合格出厂")
            ],
            total_count_cn="总数量（大写）：叁拾吨整", total_count_num="30",
            clauses=["随车司机：刘强 (13912345678)，车牌：苏A-9K231。", "运单涉及敏感电话号码脱敏验证测试。"]
        )
    ),
    (
        "09_医药器械送货单_国药控股成都_SH-20260812-99.pdf",
        build_delivery_html(
            title="医药器械商品销售出库送货单", subtitle="PHARMACEUTICAL DISTRIBUTION ORDER",
            code_label="送货单编号：", code="SH-20260812-99",
            date_label="送达日期：", date_val="2026/08/12", warehouse="西南温控医药物流中心",
            customer_label="收货客户：", customer="国药控股成都有信分公司",
            shipper_label="发货单位：", shipper="四川科伦医疗器械制造有限公司",
            rows=[
                ("MD-091", "一次性使用输液器", "INF-IV-20 (精密过滤型)", "箱", "80", "BAT20260805", "无菌灭菌"),
                ("MD-098", "医用外科灭菌口罩", "MSK-SRG-50 (挂耳式)", "箱", "100", "BAT20260808", "无菌灭菌")
            ],
            total_count_cn="送货数量（大写）：壹佰捌拾箱整", total_count_num="180",
            clauses=["全程冷链温湿度符合 GSP 规范（2-8℃）。", "收货时请核对随货同行单与温湿度记录仪。"]
        )
    ),
    (
        "10_手工急送送货清单_苏州平江餐饮_未识别.pdf",
        build_delivery_html(
            title="商品送货清单", subtitle="EMERGENCY GOODS DISPATCH LIST",
            code_label="单号：", code="",
            date_label="送货日期：", date_val="2026-10-11", warehouse="苏州平江后勤配送点",
            customer_label="收货单位：", customer="苏州平江餐饮管理有限公司",
            shipper_label="发货单位：", shipper="苏州市绿色农副产品配送中心",
            rows=[
                ("FD-001", "特选五常大米", "50kg/袋 (优质一级)", "袋", "50", "LOT-TODAY", "新鲜质优")
            ],
            total_count_cn="合计数量（大写）：伍拾袋整", total_count_num="50",
            clauses=["因系统网络临时故障未自动打印编号，用于单号缺失回退未识别与待复核测试。"]
        )
    ),

    # --- 类型三：商务报价单 (5份) ---
    (
        "11_商务报价单_杭州云端启航_BJ-20261017-01.pdf",
        build_quote_html(
            title="商务设备报价单", subtitle="COMMERCIAL HARDWARE QUOTATION",
            code_label="报价单号：", code="BJ-20261017-01",
            date_label="报价日期：", date_val="2026-10-17", expire_val="2026-10-31",
            customer_label="客户单位：", customer="杭州云端启航数据技术有限公司",
            provider_label="报价单位：", provider="苏州智胜网络通信设备有限公司",
            rows=[
                ("企业级万兆核心交换机", "智胜 NET-Core-X10 (48*10G SFP+ / 6*100G)", "2", "台", "38,000.00", "32,500.00", "65,000.00"),
                ("模块化光纤收发配线架", "智胜 FIBER-MOD-48 (含满配超低损跳线)", "6", "套", "12,000.00", "10,300.00", "61,800.00")
            ],
            total_cn="总金额大写：人民币壹拾贰万陆仟捌佰元整（含13%税）", total_val="￥126,800.00",
            clauses=["价格包含 13% 增值税专用发票、设备原厂包装及国内主要干线物流费。", "正式合同签署后 7 个工作日内完成现货备库并发出。"]
        )
    ),
    (
        "12_流水线定制报价单_合肥新能汽车_BJ-20260515-08.pdf",
        build_quote_html(
            title="工业自动化流水线定制商务报价单", subtitle="AUTOMATION ASSEMBLY LINE QUOTATION",
            code_label="报价编号：", code="BJ-20260515-08",
            date_label="出具日期：", date_val="2026年05月15日", expire_val="2026年06月14日",
            customer_label="询价客户：", customer="合肥新能汽车工业制造有限公司",
            provider_label="报价单位：", provider="安徽博力智能装备制造股份有限公司",
            rows=[
                ("动力电池包自动合装系统", "BL-BAT-ASY-5000 (六轴重载机械臂)", "1", "套", "1,800,000.00", "1,600,000.00", "1,600,000.00"),
                ("视觉引导定位与锁附模组", "BL-VISION-LOC (高精度双目相机)", "2", "套", "480,000.00", "425,000.00", "850,000.00")
            ],
            total_cn="整线含税总报价（大写）：人民币贰佰肆拾伍万元整", total_val="￥2,450,000.00",
            clauses=["整线包含机械设计、电气控制、上位机软件及现场调试交钥匙工程。"]
        )
    ),
    (
        "13_终端采购报价清单_成都天府软件_BJ-20260720-15.pdf",
        build_quote_html(
            title="IT终端设备采购报价清单", subtitle="IT WORKSTATION PURCHASE QUOTATION",
            code_label="报价单号：", code="BJ-20260720-15",
            date_label="制单时间：", date_val="2026-07-20", expire_val="2026-08-10",
            customer_label="买方客户：", customer="成都天府软件研发中心",
            provider_label="报价单位：", provider="联想企业级方案授权金牌经销商",
            rows=[
                ("专业图形工作站主机", "ThinkStation P360 (i9/64G/RTX4080)", "10", "台", "18,000.00", "15,200.00", "152,000.00")
            ],
            total_cn="优惠折后价税合计（大写）：人民币壹拾伍万贰仟元整", total_val="￥152,000.00",
            clauses=["市场参考原价为 180,000.00 元，大客户批量采购享受专项特惠折后价。"]
        )
    ),
    (
        "14_安防维保报价单_上海陆家嘴金融_BJ-20260808-01.pdf",
        build_quote_html(
            title="楼宇智能安防维保商务报价单", subtitle="BUILDING SECURITY MAINTENANCE QUOTATION",
            code_label="单据编号：", code="BJ-20260808-01",
            date_label="报价日期：", date_val="2026.08.08", expire_val="2026.09.08",
            customer_label="客户单位：", customer="上海陆家嘴金融大厦物业管理处",
            provider_label="报价单位：", provider="上海天网智能安全工程系统有限公司",
            rows=[
                ("大厦视频监控系统年度维保", "全楼宇高清摄像头巡检与维保", "1", "年", "60,000.00", "50,000.00", "50,000.00"),
                ("门禁通道闸机年度维保", "速通门闸机及人脸识别终端维保", "1", "年", "45,000.00", "38,000.00", "38,000.00")
            ],
            total_cn="年维保总金额（大写）：人民币捌万捌仟元整", total_val="￥88,000.00",
            clauses=["提供每季度一次全面设备预防性体检，2小时内现场紧急故障抢修响应。"],
            opp_code="OPP-2026-SH01"
        )
    ),
    (
        "15_海外项目报价单_中国路桥工程公司_BJ-20261102-09.pdf",
        build_quote_html(
            title="商务设备海外项目报价单", subtitle="OVERSEAS ENGINEERING PROCUREMENT QUOTATION",
            code_label="报价单号：", code="BJ-20261102-09",
            date_label="报价日期：", date_val="2026-11-02", expire_val="2026-11-30",
            customer_label="客户单位：", customer="中国路桥工程公司/阿尔及利亚项目组",
            provider_label="报价单位：", provider="徐州重型机械进出口贸易有限公司",
            rows=[
                ("重型越野车载发电机组", "GEN-500KW (康明斯柴油机组)", "2", "台", "350,000.00", "310,000.00", "620,000.00")
            ],
            total_cn="合同总额大写：人民币陆拾贰万元整（FOB上海港）", total_val="￥620,000.00",
            clauses=["客户单位中含有非法路径斜杠 /，用于验证 Windows 文件名自动安全置换预检。"]
        )
    ),

    # --- 类型四：财务对账单 (5份) ---
    (
        "16_往来结算对账单_杭州阿里巴巴_DZ-202610-01.pdf",
        build_reconciliation_html(
            title="客户往来账款结算对账单", subtitle="CUSTOMER ACCOUNT RECONCILIATION STATEMENT",
            code_label="对账单号：", code="DZ-202610-01",
            date_label="对账确认日期：", date_val="2026-11-05", period="2026年10月01日至 2026年10月31日",
            customer_label="客户名称：", customer="杭州阿里巴巴云计算技术有限公司",
            accountant_label="核算单位：", accountant="北京极光神州数据技术有限公司",
            rows=[
                ("2026-10-08", "INV-10082", "云资源混合调度服务费", "CNY", "210,000.00", "0.00", "210,000.00"),
                ("2026-10-22", "INV-10095", "大数据清洗计算服务费", "CNY", "240,800.00", "0.00", "450,800.00")
            ],
            total_cn="本期应收账款总额：人民币肆拾伍万零捌佰元整", total_val="￥450,800.00",
            clauses=["贵方对本对账单如有异议，请于收到后 5 个工作日内书面反馈，逾期视同确认。"]
        )
    ),
    (
        "17_供应商月结确认函_东莞精实五金_GYS-202609-88.pdf",
        build_reconciliation_html(
            title="供应商应付货款月结对账确认函", subtitle="SUPPLIER PAYMENT MONTHLY RECONCILIATION",
            code_label="单据编号：", code="GYS-202609-88",
            date_label="确认签署日期：", date_val="2026-10-10", period="2026年09月01日至 2026年09月30日",
            customer_label="合作供应商：", customer="东莞市精实五金模具有限公司",
            accountant_label="采购对账方：", accountant="深圳麦捷微电子科技股份有限公司",
            rows=[
                ("2026-09-12", "CG-0912", "高精密CNC铝合金加工件", "CNY", "45,000.00", "0.00", "45,000.00"),
                ("2026-09-26", "CG-0926", "五金冲压屏蔽罩批次入库", "CNY", "35,000.00", "0.00", "80,000.00")
            ],
            total_cn="不含税 80,000.00 元，税额 10,400.00 元，价税合计应付：人民币玖万零肆佰元整", total_val="￥90,400.00",
            clauses=["款项将于双方盖章确认后列入次月 15 日供应商付款计划批次统一结算。"]
        )
    ),
    (
        "18_干线运费结算清单_青岛海尔智能_WL-2026Q3-01.pdf",
        build_reconciliation_html(
            title="物流干线运输费用结算清单", subtitle="LOGISTICS FREIGHT CONSOLIDATED STATEMENT",
            code_label="结算单号：", code="WL-2026Q3-01",
            date_label="制表日期：", date_val="2026年10月08日", period="2026-07-01 至 2026-09-30 (Q3)",
            customer_label="托运客户：", customer="青岛海尔智能家居科技有限公司",
            accountant_label="承运物流：", accountant="德邦物流股份有限公司",
            rows=[
                ("2026-07-31", "WL-07", "7月份全国干线调拨运费", "CNY", "54,200.00", "0.00", "54,200.00"),
                ("2026-08-31", "WL-08", "8月份全国干线调拨运费", "CNY", "58,400.00", "0.00", "112,600.00"),
                ("2026-09-30", "WL-09", "9月份全国干线调拨运费", "CNY", "56,300.00", "0.00", "168,900.00")
            ],
            total_cn="累计应结运费：人民币壹拾陆万捌仟玖佰元整", total_val="￥168,900.00",
            clauses=["所有运单签收回单已由系统电子签收核验无误，符合季度结算标准。"]
        )
    ),
    (
        "19_代销结算对账单_中粮福临门_JS-20260831-29.pdf",
        build_reconciliation_html(
            title="商业零售代销结算对账单", subtitle="RETAIL CONSIGNMENT SALES SETTLEMENT",
            code_label="结算单据号：", code="JS-20260831-29",
            date_label="结算出具日：", date_val="2026-09-05", period="2026年08月01日至 2026年08月31日",
            customer_label="商户名称：", customer="中粮福临门食品营销有限公司",
            accountant_label="核算单位：", accountant="华润万家商业超市连锁有限公司",
            rows=[
                ("2026-08-31", "POS-08", "8月份食用油专柜销售总额", "CNY", "320,000.00", "0.00", "320,000.00"),
                ("2026-08-31", "FEE-08", "通道扣点与进场管理费(10%)", "CNY", "0.00", "32,000.00", "288,000.00")
            ],
            total_cn="扣除费用后实付代销净额：人民币贰拾捌万捌仟元整", total_val="￥288,000.00",
            clauses=["扣点依照双方代销协议约定执行，净额在确认签署后 3 个工作日电汇转账。"]
        )
    ),
    (
        "20_月度财务对账单_北京奇安信_DZ-202609-99.pdf",
        build_reconciliation_html(
            title="客户月度财务对账确认单", subtitle="MONTHLY FINANCIAL AUDIT RECONCILIATION",
            code_label="单据编号：", code="DZ-202609-99",
            date_label="确认日期：", date_val="2026-10-12", period="2026年09月01日至 2026年09月30日",
            customer_label="客户名称：", customer="北京奇安信网络安全科技有限公司",
            accountant_label="核算单位：", accountant="杭州安恒信息技术股份有限公司",
            rows=[
                ("2026-09-20", "DZ-9901", "网络安全重保巡检服务", "CNY", "88,000.00", "0.00", "88,000.00")
            ],
            total_cn="结算总额：人民币捌万捌仟元整", total_val="￥88,000.00",
            clauses=["本单据用于验证文件改名占用恢复与异常撤销重试流程。"]
        )
    ),

    # --- 类型五：工程验收单 (5份) ---
    (
        "21_系统终验合格报告_上海浦东发展银行_YS-2026-0412.pdf",
        build_acceptance_html(
            title="信息化系统建设工程最终验收合格报告", subtitle="FINAL ACCEPTANCE & COMMISSIONING REPORT",
            code_label="验收编号：", code="YS-2026-0412",
            date_label="验收评审通过日期：", date_val="2026年10月10日", project="智能客服核心平台升级二期",
            client_label="建设单位（业主）：", client="上海浦东发展银行股份有限公司",
            contractor_label="承建单位：", contractor="科大讯飞智能科技股份有限公司",
            rows=[
                ("多渠道智能语音坐席引擎", "支持并发≥2000路，ASR识别率≥98%", "1", "套", "合格", "性能压测达标"),
                ("全量智能质检分析模块", "支持百路实时质检与敏感词阻断", "1", "套", "合格", "安全合规达标")
            ],
            conclusion="经联合专家评审组现场核验与压力测试，系统功能与技术性能均符合技术协议指标，验收合格予以正式交付上线。",
            clauses=["自验收合格之日起进入免费质保期，承建单位提供 7×24 小时现场与远程应急技术支持。"]
        )
    ),
    (
        "22_机房工程初验证明_南京大学网络中心_YS-20260920-03.pdf",
        build_acceptance_html(
            title="数据中心弱电机房初步验收交接书", subtitle="PRELIMINARY ACCEPTANCE & HANDOVER CERTIFICATE",
            code_label="单据编号：", code="YS-20260920-03",
            date_label="初验日期：", date_val="2026-09-20", project="仙林校区核心算力机房扩建工程",
            client_label="使用客户：", client="南京大学仙林校区网络中心",
            contractor_label="施工总包：", contractor="中通服建设有限公司",
            rows=[
                ("机房精密变频空调", "Liebert 40kW 下送风型", "4", "台", "合格", "制冷温控正常"),
                ("模块化高频UPS电源", "Vertiv 200kVA (1+1并联冗余)", "2", "套", "合格", "满载切换正常"),
                ("智能配电列头柜及防雷", "SP-Cab-630A (含电量监测)", "6", "面", "合格", "监控通讯正常")
            ],
            conclusion="现场各项设备安装工艺规范、布线整齐，试运转72小时参数平稳，初验合格，准予进入试运行期。",
            clauses=["试运行期为 3 个月，试运行平稳结束后组织终验与竣工审计交接。"]
        )
    ),
    (
        "23_医疗设备安装合格单_四川大学华西第二医院_YS-202607-88.pdf",
        build_acceptance_html(
            title="医疗仪器设备安装调试与培训验收合格单", subtitle="MEDICAL EQUIPMENT INSTALLATION ACCEPTANCE",
            code_label="验收单号：", code="YS-202607-88",
            date_label="签字验收日期：", date_val="2026/07/25", project="锦江院区影像中心设备更新",
            client_label="医疗机构单位：", client="四川大学华西第二医院",
            contractor_label="设备供应商：", contractor="通用电气医疗系统（中国）有限公司",
            rows=[
                ("超导核磁共振成像系统", "SIGNA Pioneer 3.0T", "1", "套", "合格", "装机测试成像优秀")
            ],
            conclusion="整机物理安装、磁体励磁与射频屏蔽指标完全达标，操作人员临床培训已顺利完成，验收合格。",
            clauses=["原厂提供三年整机全保（含球管与冷头）及定期校准检测。"]
        )
    ),
    (
        "24_消防工程竣工验收证明_深圳卓越商业地产_YS-20260518-消防01.pdf",
        build_acceptance_html(
            title="建筑工程消防安全设施竣工验收证明书", subtitle="FIRE SAFETY ENGINEERING ACCEPTANCE CERTIFICATE",
            code_label="验收案号：", code="YS-20260518-消防01",
            date_label="勘验日期：", date_val="2026年05月18日", project="卓越前海壹号商业中心A座消防工程",
            client_label="建设单位：", client="深圳市卓越商业地产投资有限公司",
            contractor_label="施工总包：", contractor="中国建筑第二工程局有限公司",
            rows=[
                ("自动喷淋灭火管网系统", "湿式报警阀组及高压喷头", "1", "项", "合格", "压力联动响应正常"),
                ("火灾自动报警联动主机", "感烟探测及防排烟联动柜", "1", "项", "合格", "声光联动试验合格")
            ],
            conclusion="经现场抽测检验，消防水压、排烟联动及应急疏散指示系统均符合《建筑设计防火规范》，合格准予交付。",
            clauses=["建设单位应按规定建立日常巡检台账，定期组织消防演练。"]
        )
    ),
    (
        "25_设备到货开箱检验报告_中电科技38所_YS-202610-99.pdf",
        build_acceptance_html(
            title="设备到货开箱检验合格报告", subtitle="GOODS ARRIVAL INCOMING INSPECTION REPORT",
            code_label="报告号：", code="YS-202610-99",
            date_label="验收日期：", date_val="2026-10-15", project="雷达信号高速采集前端预研",
            client_label="收货单位：", client="中国电子科技集团第三十八研究所",
            contractor_label="承建单位：", contractor="成都华微电子科技有限公司",
            rows=[
                ("超宽带高速ADC采集卡", "ADC-5GSPS-Quad (PCIe 4.0)", "2", "块", "合格", "通道眼图测试正常")
            ],
            conclusion="外观良好无划痕、序列号与装箱清单一致，加电自检与固件通讯正常，开箱验收合格。",
            clauses=["本单据用于多文件改名时部分失败处理与异常 CSV 导出回归测试。"]
        )
    ),

    # --- 类型六：增值税发票 (5份) ---
    (
        "26_增值税电子普通发票_北京东方网力_20881923.pdf",
        build_invoice_html(
            title="增值税电子普通发票", inv_code="011002000111", inv_num="20881923",
            date_label="开票日期：", date_val="2026年08月20日",
            buyer_label="购买方名称：", buyer="北京东方网力科技股份有限公司", buyer_tax="91110108722619283X",
            seller_label="销售方名称：", seller="北京京东世纪贸易有限公司", seller_tax="91110302660505191H",
            rows=[
                ("*办公用品*无线双模静音键鼠套装", "MK-Pro", "套", "5", "283.01", "1,415.05", "13%", "183.95")
            ],
            total_cn="人民币壹仟伍佰玖拾玖元整", total_val="￥1,599.00"
        )
    ),
    (
        "27_数电专票_上海蔚来汽车_26112000000123456789.pdf",
        build_invoice_html(
            title="电子发票（增值税专用发票）", inv_code="", inv_num="26112000000123456789",
            date_label="开票日期：", date_val="2026年09月15日",
            buyer_label="购买方名称：", buyer="上海蔚来汽车销售服务有限公司", buyer_tax="91310114MA1GW3928L",
            seller_label="销售方名称：", seller="宁德时代新能源科技股份有限公司", seller_tax="91350900587526834Q",
            rows=[
                ("*汽车零部件*高压动力电池BMS线束", "BMS-HARN-V3", "套", "10", "1,132.74", "11,327.43", "13%", "1,472.57")
            ],
            total_cn="人民币壹万贰仟捌佰元整", total_val="￥12,800.00"
        )
    ),
    (
        "28_机动车销售统一发票_张维_00582910.pdf",
        build_invoice_html(
            title="机动车销售统一发票", inv_code="111002100012", inv_num="00582910",
            date_label="开票日期：", date_val="2026-06-18",
            buyer_label="购买方名称及身份证号码/组织机构代码：", buyer="张维", buyer_tax="32010619880912120X",
            seller_label="销货单位名称：", seller="南京中升雷克萨斯汽车销售服务有限公司", seller_tax="91320115783519280M",
            rows=[
                ("*车辆*雷克萨斯 ES300h 卓越版", "ES300h-2.5L", "辆", "1", "237,168.14", "237,168.14", "13%", "30,831.86")
            ],
            total_cn="人民币贰拾陆万捌仟元整", total_val="￥268,000.00"
        )
    ),
    (
        "29_行程报销汇总单_深圳金蝶软件_DD-20261011-889.pdf",
        build_invoice_html(
            title="滴滴出行行程报销单", inv_code="", inv_num="DD-20261011-889",
            date_label="申请日期：", date_val="2026-10-12",
            buyer_label="申请人/企业客户：", buyer="深圳金蝶软件科技有限公司", buyer_tax="91440300618840192A",
            seller_label="网约车服务平台：", seller="滴滴出行科技有限公司", seller_tax="91120116340983383W",
            rows=[
                ("*客运服务*商务公干网约车行程汇总", "快车/专车合规服务", "次", "8", "430.53", "430.53", "13%", "55.97")
            ],
            total_cn="人民币肆佰捌拾陆元伍角整", total_val="￥486.50"
        )
    ),
    (
        "30_增值税专用发票_广州广电运通_88210394.pdf",
        build_invoice_html(
            title="增值税专用发票", inv_code="044002000211", inv_num="88210394",
            date_label="开票日期：", date_val="2026年07月07日",
            buyer_label="购买方名称：", buyer="广州广电运通金融电子股份有限公司", buyer_tax="91440101718151900K",
            seller_label="销售方名称：", seller="广州立讯电子工业科技开发有限公司", seller_tax="91440116693570192T",
            rows=[
                ("*电子元器件*金融机具专用加密键盘", "EPP-V6-PCI", "台", "10", "513.27", "5,132.74", "13%", "667.26")
            ],
            total_cn="人民币伍仟捌佰元整", total_val="￥5,800.00"
        )
    )
]

def generate_profiles():
    print("Writing OCR JSON Profile configurations...")
FOLDER_MAPPING = [
    ("01_采购合同", "purchase-contract", "采购合同_OCR配置.json"),
    ("02_销售送货单", "delivery-order", "销售送货单_OCR配置.json"),
    ("03_商务报价单", "quotation-sheet", "商务报价单_OCR配置.json"),
    ("04_财务对账单", "reconciliation-statement", "财务对账单_OCR配置.json"),
    ("05_工程验收单", "acceptance-certificate", "工程验收单_OCR配置.json"),
    ("06_增值税发票", "vat-invoice", "增值税发票_OCR配置.json"),
]

def generate_profiles():
    print("Writing OCR JSON Profile configurations...")
    for folder, pid, fname in FOLDER_MAPPING:
        folder_path = os.path.join(OUTPUT_DIR, folder)
        os.makedirs(folder_path, exist_ok=True)
        profile = PROFILES[pid]
        # Write to subfolder
        with open(os.path.join(folder_path, fname), "w", encoding="utf-8") as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
        # Also write to root OUTPUT_DIR for central access
        with open(os.path.join(OUTPUT_DIR, fname), "w", encoding="utf-8") as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
        print(f" -> Created profile: {folder}/{fname}")

    # Combined all 6 profiles in root OUTPUT_DIR
    all_profiles = list(PROFILES.values())
    combined_path = os.path.join(OUTPUT_DIR, "全部OCR配置_合辑.json")
    with open(combined_path, "w", encoding="utf-8") as f:
        json.dump(all_profiles, f, ensure_ascii=False, indent=2)
    print(" -> Created collection: 全部OCR配置_合辑.json")

    # Retain legacy file name for compatibility
    legacy_path = os.path.join(OUTPUT_DIR, "全部三套OCR配置_合辑.json")
    with open(legacy_path, "w", encoding="utf-8") as f:
        json.dump(all_profiles[:3], f, ensure_ascii=False, indent=2)
    print(" -> Updated legacy collection: 全部三套OCR配置_合辑.json")

def generate_pdfs():
    print(f"\nGenerating {len(ALL_CASES)} PDF sample documents categorized by folder...")
    # Clean up legacy un-categorized PDFs in root OUTPUT_DIR
    for f in os.listdir(OUTPUT_DIR):
        if (f.endswith(".pdf") and f[0:2].isdigit()) or f in ("1.pdf", "2.pdf", "3.pdf", "4.pdf", "test_01.pdf", "01_test.pdf"):
            try:
                os.remove(os.path.join(OUTPUT_DIR, f))
            except Exception:
                pass

    for idx, (filename, html_content) in enumerate(ALL_CASES, 1):
        folder_idx = (idx - 1) // 5
        folder_name = FOLDER_MAPPING[folder_idx][0]
        folder_path = os.path.join(OUTPUT_DIR, folder_name)
        os.makedirs(folder_path, exist_ok=True)
        pdf_path = os.path.join(folder_path, filename)

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
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            os.remove(temp_html)
        except Exception:
            pass

        if os.path.exists(pdf_path):
            size = os.path.getsize(pdf_path)
            print(f" [{idx:02d}/{len(ALL_CASES)}] Success: {folder_name}/{filename} ({size} bytes)", flush=True)
        else:
            print(f" [{idx:02d}/{len(ALL_CASES)}] Failed: {folder_name}/{filename}", flush=True)

if __name__ == "__main__":
    generate_profiles()
    generate_pdfs()
    print("\nAll OCR sample files and profiles categorized and generated successfully!")

