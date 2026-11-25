use super::model::*;
use regex::Regex;
use std::{collections::{BTreeMap,HashSet},path::Path,sync::OnceLock};

#[cfg(test)]
#[path = "rules_tests.rs"]
mod tests;

pub fn canonical_date_format(format:&str)->Option<&'static str>{
    match format.trim(){
        ""=>Some(""),
        "%Y%m%d"=>Some("%Y%m%d"),
        "%Y-%m-%d"=>Some("%Y-%m-%d"),
        "%Y/%m/%d"=>Some("%Y/%m/%d"),
        "%Y年%m月%d日"=>Some("%Y年%m月%d日"),
        display=>match display.to_ascii_uppercase().as_str(){
            "YYYYMMDD"=>Some("%Y%m%d"),
            "YYYY-MM-DD"=>Some("%Y-%m-%d"),
            "YYYY/MM/DD"=>Some("%Y/%m/%d"),
            "YYYY年MM月DD日"=>Some("%Y年%m月%d日"),
            _=>None,
        }
    }
}

pub fn validate(p:&OcrProfile)->Result<(),String>{
    if p.id.is_empty()||p.id.len()>80||!p.id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){return Err("配置 ID 无效".into());}
    if p.name.trim().is_empty()||p.name.len()>300||p.fields.len()>40||!(100..=400).contains(&p.dpi)||!p.threshold.is_finite()||!(0.0..=1.0).contains(&p.threshold){return Err("配置名称、字段数量、DPI 或复核阈值无效".into());}
    if p.pages!="all" {for part in p.pages.split(','){let parts:Vec<_>=part.trim().split('-').collect();let a=parts.first().and_then(|v|v.parse::<u32>().ok()).filter(|v|*v>0&&*v<=10000).ok_or("页范围应为 all、1 或 1-3,5")?;if parts.len()>2||parts.len()==2&&parts[1].parse::<u32>().map(|b|b<a||b>10000).unwrap_or(true){return Err("页范围无效".into());}}}
    if p.regions.len()>20 || p.regions.iter().any(|r|r.page>10000 || [r.x,r.y,r.width,r.height].iter().any(|v|!v.is_finite()) || r.x<0.0 || r.y<0.0 || r.width<=0.0 || r.height<=0.0 || r.x+r.width>1.000001 || r.y+r.height>1.000001){return Err("识别区域必须在页面内，最多 20 个区域".into());}
    let mut keys=HashSet::new();
    for f in &p.fields {
        if f.key.trim().is_empty()||f.key.len()>100||f.key.contains(['{','}'])||f.key=="原文件名"||!keys.insert(&f.key){return Err("字段名不能为空、重复或使用保留名称/花括号".into());}
        if !["text","date","number"].contains(&f.kind.as_str())||!(1..=20).contains(&f.max_items)||f.prompt.len()>3000{return Err("字段类型、多值数量或说明长度无效".into());}
        if !f.pattern.is_empty(){regex::RegexBuilder::new(&f.pattern).size_limit(1_000_000).build().map_err(|e|format!("正则无效：{e}"))?;}
        if f.kind=="date"&&!f.format.is_empty()&&!['%'].iter().all(|_|["%Y%m%d","%Y-%m-%d","%Y/%m/%d","%Y年%m月%d日"].contains(&f.format.as_str())){return Err("日期格式请选择 YYYYMMDD、YYYY-MM-DD、YYYY/MM/DD 或中文日期".into());}
        if f.kind=="number"&&!f.format.is_empty()&&!matches!(f.format.as_str(),"0"|"1"|"2"|"3"|"4"|"5"|"6"){return Err("数字小数位应为 0–6".into());}
    }
    if p.regions.iter().any(|r|r.field_key.as_ref().is_some_and(|key|!keys.contains(key))){return Err("区域绑定的字段不存在，请重新选择字段".into());}
    // 画像词只作用于当前配置：每类最多 40 个、单个最多 30 字，超限拒绝保存。
    for (label, words) in [("内部标题", &p.extra_titles), ("分节噪声词", &p.noise_markers), ("专有表头", &p.extra_headers)] {
        if words.len() > 40 { return Err(format!("{label}最多 40 个")); }
        if words.iter().any(|w| w.chars().count() > 30) { return Err(format!("{label}单个最多 30 字")); }
    }
    if p.filename_pattern.is_empty()||p.filename_pattern.len()>1000{return Err("命名格式不能为空或过长".into());}
    let re=Regex::new(r"\{([^{}]+)\}").unwrap();
    for c in re.captures_iter(&p.filename_pattern){if &c[1]!="原文件名"&&!keys.iter().any(|k|k.as_str()==&c[1]){return Err(format!("命名格式引用了未知字段：{}",&c[1]));}}
    if re.replace_all(&p.filename_pattern,"").contains(['{','}']){return Err("命名格式花括号不完整".into());}
    if serde_json::to_vec(p).map_err(|e|e.to_string())?.len()>100_000{return Err("配置过大".into());}Ok(())
}

fn numeric_cn(c:char)->bool{"零〇一二三四五六七八九十百千万亿兆两壹贰叁肆伍陆柒捌玖拾佰仟萬億幺".contains(c)}
fn is_cn_amount(s:&str)->bool{s.chars().all(|c|numeric_cn(c)||"元整角分".contains(c))&&s.chars().any(|c|numeric_cn(c))}

pub fn mask(s:&str)->String{
    static DATE:OnceLock<Regex>=OnceLock::new();
    static DATE8:OnceLock<Regex>=OnceLock::new();
    static PHONE:OnceLock<Regex>=OnceLock::new();
    static RANGE:OnceLock<Regex>=OnceLock::new();
    static PRICE:OnceLock<Regex>=OnceLock::new();
    static CN_AMOUNT:OnceLock<Regex>=OnceLock::new();
    let date_re=DATE.get_or_init(||Regex::new(r"\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?").unwrap());
    let date8_re=DATE8.get_or_init(||Regex::new(r"(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])").unwrap());
    let mut protected:Vec<(usize,usize)>=Vec::new();
    let digit_at=|pos:usize|->bool{s.as_bytes().get(pos).is_some_and(|b|b.is_ascii_digit())};
    for m in date_re.find_iter(s){
        if (m.start()>0&&digit_at(m.start()-1))||digit_at(m.end()){continue;}
        protected.push((m.start(),m.end()));
    }
    for m in date8_re.find_iter(s){
        if (m.start()>0&&digit_at(m.start()-1))||digit_at(m.end()){continue;}
        let before=s[..m.start()].chars().rev().take(8).collect::<String>().chars().rev().collect::<String>();
        let after=s[m.end()..].chars().take(4).collect::<String>();
        if ["金额","合计","总价","单价","价款"].iter().any(|v|before.contains(v))||after.contains(['元','￥']){continue;}
        // 无标签的八位数也可能是金额，宁可交给本地规则提取日期，不让它原样出站。
        if !["日期","签约","签订","制单","出具","生效","起始","Date"].iter().any(|v|before.contains(v)){continue;}
        if !protected.iter().any(|(a,b)|m.start()>=*a&&m.end()<=*b){protected.push((m.start(),m.end()));}
    }
    protected.sort_by_key(|(a,_)|*a);
    let trimmed=s.trim();
    if (1..=3).contains(&trimmed.len())&&trimmed.bytes().all(|b|b.is_ascii_digit()){return s.to_owned();}

    let in_protected=|byte_pos:usize|->bool{protected.iter().any(|(a,b)|byte_pos>=*a&&byte_pos<*b)};
    let in_masked=|ranges:&[(usize,usize,&str)],byte_pos:usize|->bool{ranges.iter().any(|(a,b,_)|byte_pos>=*a&&byte_pos<*b)};
    let mut mask_ranges:Vec<(usize,usize,&str)>=Vec::new();

    // 手机号、固定电话、银行账号等长数字串直接脱敏，原文绝不出站
    let phone_re=PHONE.get_or_init(||Regex::new(r"\d{10,}|\d{4}(?:[-\s]\d{4}){2,}(?:[-\s]\d{2,4})?|\d{3,4}[-\s]?\d{3,4}[-\s]?\d{4}").unwrap());
    for m in phone_re.find_iter(s){
        if in_protected(m.start())||in_masked(&mask_ranges,m.start()){continue;}
        mask_ranges.push((m.start(),m.end(),"[号码已脱敏]"));
    }

    // 价格区间（如“85-100元/kg”）：整段脱敏；三段及以上纯数字短横线链（如 3-294-5010）是产品编码，不脱敏
    let range_re=RANGE.get_or_init(||Regex::new(r"(?:(?:￥|\$)\s*)?(\d[\d,，]*(?:\.\d+)?(?:\s*[-–—~～]\s*\d[\d,，]*(?:\.\d+)?)+)\s*(?:元|万元)?").unwrap());
    for c in range_re.captures_iter(s){
        let m=c.get(0).unwrap();
        if in_protected(m.start())||in_masked(&mask_ranges,m.start()){continue;}
        let before=if m.start()>0{s.as_bytes().get(m.start()-1).copied()}else{None};
        if before.is_some_and(|b|b.is_ascii_alphabetic()||b==b'-'){continue;}
        let chain=c.get(1).unwrap().as_str();
        let segments:Vec<&str>=chain.split(|ch|matches!(ch,'-'|'–'|'—'|'~'|'～')).collect();
        let to_num=|v:&str|->Option<f64>{v.chars().filter(|ch|ch.is_ascii_digit()||*ch=='.').collect::<String>().parse::<f64>().ok()};
        let has_decimal=chain.contains('.');
        let has_currency=m.as_str().contains(['￥','$','元']);
        let big=segments.iter().any(|v|to_num(v).is_some_and(|v|v>=100.0));
        if segments.len()>=3&&!has_decimal&&!has_currency{continue;}
        if has_decimal||has_currency||big{mask_ranges.push((m.start(),m.end(),"[价格已脱敏]"));}
    }

    let price_re=PRICE.get_or_init(||Regex::new(r"(?:(?:￥|\$)\s*)?(\d[\d,，]*(?:\.\d+)?)\s*(?:元|万元)?").unwrap());
    for m in price_re.find_iter(s){
        if in_protected(m.start())||in_masked(&mask_ranges,m.start()){continue;}
        let num_part=m.as_str().trim();
        let before=if m.start()>0{s.as_bytes().get(m.start()-1).copied()}else{None};
        let after=s.as_bytes().get(m.end()).copied();
        let alpha_ctx=before.is_some_and(|c|c.is_ascii_alphabetic()||c==b'-')||after.is_some_and(|c|c.is_ascii_alphabetic()||c==b'-');
        if alpha_ctx{continue;}
        let has_decimal=num_part.contains('.');
        let num_str:String=num_part.chars().filter(|c|c.is_ascii_digit()||*c=='.').collect();
        if let Ok(val)=num_str.parse::<f64>(){
            let has_currency=num_part.starts_with('￥')||num_part.starts_with('$')||num_part.ends_with("元")||num_part.ends_with("万元");
            if has_decimal||has_currency||val>=100.0{
                mask_ranges.push((m.start(),m.end(),"[价格已脱敏]"));
            }
        }
    }
    let cn_amount_re=CN_AMOUNT.get_or_init(||Regex::new(r"[壹贰叁肆伍陆柒捌玖拾佰仟萬億][零〇一二三四五六七八九十百千万亿兆两壹贰叁肆伍陆柒捌玖拾佰仟萬億幺元整角分]*|[零〇一二三四五六七八九十百千万亿兆两幺元整角分]{3,}").unwrap());
    for m in cn_amount_re.find_iter(s){
        if in_protected(m.start())||in_masked(&mask_ranges,m.start()){continue;}
        if is_cn_amount(m.as_str()){mask_ranges.push((m.start(),m.end(),"[价格已脱敏]"));}
    }
    mask_ranges.sort_by_key(|(a,_,_)|*a);
    let mut out=String::new();
    let mut pos=0;
    for &(start,end,label) in &mask_ranges{
        if start<pos{continue;}
        out.push_str(&s[pos..start]);
        out.push_str(label);
        pos=end;
    }
    out.push_str(&s[pos..]);
    out
}

fn rect(line:&OcrLine)->Option<(f64,f64,f64,f64)>{
    let points:Vec<_>=line.r#box.iter().filter(|p|p.len()>=2&&p[0].is_finite()&&p[1].is_finite()).collect();
    if points.len()<2{return None;}
    let (mut left,mut top,mut right,mut bottom)=(f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY);
    for p in points{left=left.min(p[0]);top=top.min(p[1]);right=right.max(p[0]);bottom=bottom.max(p[1]);}
    (right>left&&bottom>top).then_some((left,top,right,bottom))
}

fn clean_label(s:&str)->String{s.chars().filter(|c|!c.is_whitespace()&&!"：:，,、/()（）-_\\".contains(*c)).collect()}

fn is_customer_field(f:&OcrFieldDefinition)->bool{
    [&f.key].into_iter().chain(f.anchors.iter()).any(|label|
        ["客户","买方","购买方","采购方","采购单位","需方","购货"].iter().any(|role|label.contains(role)))
}

fn matching_anchor<'a>(text:&str,anchors:&'a [String])->Option<&'a str>{
    anchors.iter().filter(|a|!a.is_empty()&&text.contains(a.as_str())).max_by_key(|a|a.chars().count()).map(String::as_str)
}

/// Match a configured field to a table header without hard-coding document types.
/// Exact field names and user anchors win. A `名称` field can also use a common
/// `型号`/`牌号` heading because many business tables combine code and name there.
fn field_header_matches(f:&OcrFieldDefinition,text:&str)->bool{
    let label=clean_label(text);
    if label.chars().count()<2||label.chars().count()>30{return false;}
    if text.contains(['：',':']){return false;} // 包含冒号的行是“标签:取值”表单行，不是表格列头
    let mut configured=f.anchors.iter().map(|v|clean_label(v)).collect::<Vec<_>>();
    configured.push(clean_label(&f.key));
    // 只允许表头文字包含配置项，反向包含会让“报价”命中“报价单”这类两字短标签
    if configured.iter().any(|v|v.chars().count()>=2&&(label==*v||label.contains(v))){return true;}
    let key=clean_label(&f.key);
    if let Some(stem)=key.strip_suffix("名称"){
        if stem.chars().count()>=2&&label.starts_with(stem){
            let suffix=&label[stem.len()..];
            return ["名称","型号","牌号","品名","项目","内容"].contains(&suffix);
        }
    }
    false
}

fn table_column_candidates_for(profile:&OcrProfile,lines:&[OcrLine],f:&OcrFieldDefinition)->Vec<usize>{
    let mut result=vec![];
    for (header_index,header) in lines.iter().enumerate(){
        if !field_header_matches(f,&header.text){continue;}
        let Some((hl,ht,hr,hb))=rect(header)else{continue};
        let header_center=(hl+hr)/2.0;
        let mut peers=lines.iter().enumerate().filter_map(|(i,line)|{
            if i==header_index||line.page!=header.page||!is_same_row(header,line){return None;}
            let clean=clean_label(&line.text);
            if !generic_header(&clean)&&!profile_header(profile,&clean)&&!profile.fields.iter().any(|field|field_header_matches(field,&line.text)){return None;}
            rect(line).map(|r|(i,r))
        }).collect::<Vec<_>>();
        if peers.is_empty(){continue;} // A form label is not a table column header.
        peers.sort_by(|a,b|((a.1.0+a.1.2)/2.0).total_cmp(&((b.1.0+b.1.2)/2.0)));
        let left=peers.iter().filter(|(_,r)|(r.0+r.2)/2.0<header_center).map(|(_,r)|r.2).fold(f64::NEG_INFINITY,f64::max);
        let right=peers.iter().filter(|(_,r)|(r.0+r.2)/2.0>header_center).map(|(_,r)|r.0).fold(f64::INFINITY,f64::min);
        for (index,line) in lines.iter().enumerate().skip(header_index+1){
            if line.page!=header.page{continue;}
            let Some((l,t,r,b))=rect(line)else{continue};
            if (t+b)/2.0<=(ht+hb)/2.0{continue;}
            let center=(l+r)/2.0;
            if center<=left||center>=right{continue;}
            let clean=clean_label(&line.text);
            if ["合计","总计","小计","备注","说明"].iter().any(|v|clean==*v||clean.starts_with(v)){break;}
            let noisy = field_header_matches(f,&line.text)||is_rejected_candidate(Some(profile),f,&line.text);
            if noisy{continue;}
            if format_value(&line.text,f).is_some()&&!result.contains(&index){result.push(index);}
        }
    }
    result
}

/// Return values found underneath a matching header in a multi-column OCR table.
/// Column limits come from adjacent headers on the same row, so this works for any
/// configured field and does not depend on a particular customer or product name.
/// 画像感知版本：噪声判断走配置；无画像的纯通用测试走 table_column_candidates。

/// 通用版式标题：只保留跨行业通用的单据类型后缀，不收录任何一家企业的内部版式名。
/// 某一样本特有的标题必须走配置 extra_titles，由用户画像提供。
#[cfg(test)]
fn blank_profile()->OcrProfile{
    OcrProfile {
        id: String::new(), name: String::new(), keywords: vec![], pages: "all".into(), dpi: 200,
        regions: vec![], fields: vec![], filename_pattern: "{原文件名}".into(), threshold: 0.75,
        extra_titles: vec![], noise_markers: vec![], extra_headers: vec![],
    }
}
/// 通用版式标题：跨行业通用的单据类型（报价/比价/合同/协议/送货/对账），
/// 以“类型后缀”收敛，特定版式名由用户画像提供。
fn generic_doc_title(clean:&str)->bool{
    const GENERIC_SUFFIXES: [&str; 7] = ["报价单", "物料报价单", "比价单", "合同", "协议书", "送货单", "对账单"];
    if ["报价单", "比价单", "送货单", "对账单"].contains(&clean) { return true; }
    GENERIC_SUFFIXES.iter().any(|s| clean.ends_with(s)) || clean == "原材料物料报价单"
}

fn profile_doc_title(p:&OcrProfile, clean:&str)->bool{
    if generic_doc_title(clean) { return true; }
    p.extra_titles.iter().any(|t| {
        let t: String = t.chars().filter(|c|!c.is_whitespace()&&!"\u{ff0c},\u{3001}/()\u{ff08}\u{ff09}:\u{ff1a}-_\\".contains(*c)).collect();
        !t.is_empty() && (clean == t || clean.contains(t.as_str()))
    })
}

/// 通用产品噪声标记只保留跨行业价格说明。
/// 特定版式的章节词与保密标记由用户画像 noise_markers 提供。
fn generic_noise_marker(clean:&str)->bool{
    const GENERIC: [&str; 2] = ["不含税", "含税价格"];
    GENERIC.iter().any(|m| clean.contains(m))
}

fn profile_noise_marker(p:&OcrProfile, clean:&str)->bool{
    if generic_noise_marker(clean) { return true; }
    p.noise_markers.iter().any(|m| !m.is_empty() && clean.contains(m.as_str()))
}

/// 通用产品表头：跨行业表格列名，某一样本特有的列走 extra_headers。
fn generic_header(h:&str)->bool{
    const GENERIC: [&str; 52] = [
        "规格","型号","规格型号","产品型号","物料型号","品名型号","货物型号","产品名称及型号","产品名称及规格","物料名称及规格","物料名称及型号",
        "单位","数量","单价","金额","总价","小计","合计","备注","序号","税率","税额","未税","含税",
        "材料牌号","材料类型","车型","品号","颜色","批号","交期","车间","包装","品牌","未税元","kg桶","桶",
        "日期","报价日期","签约日期","签订日期","时间","地址","电话","传真","邮箱","客户","买方","需方","供方","产品名称","物料名称"
    ];
    GENERIC.contains(&h)||["qty","quantity","unit","price","amount","no","item","description","model","specification"].contains(&h.to_ascii_lowercase().as_str())
}

fn profile_header(p:&OcrProfile, clean:&str)->bool{
    for h in p.extra_headers.iter().filter(|h| !h.is_empty()) {
        if clean == h.as_str() || clean.starts_with(h.as_str()) { return true; }
    }
    for h in ["规格", "单价", "数量", "金额"].iter().filter(|h| generic_header(h)) {
        if clean.len() <= 6 && clean.starts_with(*h) { return true; }
    }
    if clean.len() <= 6 && clean.ends_with("日期") { return true; }
    false
}

pub fn is_noise_or_header_for(profile:Option<&OcrProfile>,val:&str,field_key:&str)->bool{
    let s=val.trim();
    if s.is_empty(){return true;}
    let clean:String=s.chars().filter(|c|!c.is_whitespace()&&!"\u{ff0c},\u{3001}/()\u{ff08}\u{ff09}:\u{ff1a}-_\\".contains(*c)).collect();
    let doc_hit = match profile {
        Some(p) => profile_doc_title(p, &clean),
        None => generic_doc_title(&clean),
    };
    if doc_hit{
        if field_key.contains("产品")||field_key.contains("品名")||field_key.contains("物料"){return true;}
    }
    if field_key.contains("产品")||field_key.contains("品名")||field_key.contains("物料"){
        let marker_hit = match profile {
            Some(p) => profile_noise_marker(p, &clean),
            None => generic_noise_marker(&clean),
        };
        if marker_hit{
            return true;
        }
        // 月/年报价这类“xx报价”短语：通用规则只认“以报价结尾且长度<=12”的短标题，
        // 长句（如“报价有效期至”）不算噪声，避免误杀。
        if clean.ends_with("报价") && clean.chars().count() <= 12 && clean != "报价" {
            return true;
        }
        let extra_hit = profile.is_some_and(|p| profile_header(p, &clean));
        let generic_hit = {
            let headers=[
                "规格","型号","规格型号","产品型号","物料型号","品名型号","货物型号","产品规格","物料规格","品名规格",
                "产品名称","物料名称","产品名称及规格","产品名称及型号","物料名称及规格","物料名称及型号",
                "单位","数量","单价","金额","总价","小计","合计","备注","序号","税率","税额","未税","含税",
                "材料牌号","材料类型","车型","品号","颜色","批号","交期","车间","包装","品牌","未税元","kg桶","桶",
                "日期","报价日期","签约日期","签订日期","时间","地址","电话","传真","邮箱","客户","买方","需方","供方"
            ];
            headers.iter().any(|h| clean==*h||clean.starts_with(*h)||(clean.chars().count()<=8&&(clean.starts_with("规格")||clean.starts_with("单价")||clean.starts_with("数量")||clean.starts_with("金额")||clean.ends_with("型号")||clean.ends_with("规格")||clean.ends_with("日期"))))
        };
        if extra_hit || generic_hit {
            return true;
        }
    }
    if field_key.contains("客户")||field_key.contains("买方")||field_key.contains("需方"){
        let supplier_keywords=["供方","供应商","卖方","销售方","报价方","开票方"];
        for sk in supplier_keywords{if clean.starts_with(sk){return true;}}
    }
    false
}

/// 检查某个候选文本（无论是原始 OCR 文本还是 format_value 剥离前缀后的文本）是否应当被拒绝
pub fn is_rejected_candidate(profile: Option<&OcrProfile>, f: &OcrFieldDefinition, text: &str) -> bool {
    let raw = text.trim();
    if raw.is_empty() { return true; }
    if is_noise_or_header_for(profile, raw, &f.key) { return true; }
    let clean: String = raw.chars().filter(|c| !c.is_whitespace() && !"\u{ff0c},\u{3001}/()\u{ff08}\u{ff09}:\u{ff1a}-_\\".contains(*c)).collect();
    if clean.is_empty() { return true; }
    if profile.is_some_and(|p|p.noise_markers.iter().any(|marker|{
        let marker=clean_label(marker);!marker.is_empty()&&clean.contains(&marker)
    })){return true;}
    if is_customer_field(f)&&["供方","供应商","卖方","销售方","报价方","开票方"].iter().any(|role|clean.starts_with(role)){return true;}
    if clean == "型号" || clean == "规格" || clean == "产品型号" || clean == "物料型号" || clean == "品名型号" || clean == "产品名称" || clean == "物料名称" {
        return true;
    }
    // 贯彻用户在 prompt 中写下的排除策略（如排除包含“型号”的文本）
    if (f.prompt.contains("排除") || f.prompt.contains("严禁") || f.prompt.contains("不含"))
        && f.prompt.contains("型号")
        && (clean.contains("型号") || raw.contains("型号"))
    {
        return true;
    }
    false
}

#[derive(Clone,Copy,PartialEq)]
enum DateRole{Document,Expiry,Print}
fn date_label(text:&str)->Option<DateRole>{
    static LABEL:OnceLock<Regex>=OnceLock::new();
    let pattern=LABEL.get_or_init(||Regex::new("报价日期|签约日期|签订日期|制单日期|出具日期|生效日期|起始日期|有效期限至|有效期至|有效至|截止日期|截止时间|截止|到期日|结束日期|打印时间|打印日期|导出时间|导出日期|制表时间|生成时间|日期").unwrap());
    pattern.find_iter(text).last().map(|label|match label.as_str(){
        "有效期限至"|"有效期至"|"有效至"|"截止日期"|"截止时间"|"截止"|"到期日"|"结束日期"=>DateRole::Expiry,
        "打印时间"|"打印日期"|"导出时间"|"导出日期"|"制表时间"|"生成时间"=>DateRole::Print,
        _=>DateRole::Document,
    })
}
// 判断实际选中的日期，不让同一行后面的截止标签或 OCR 数组顺序否决前一个日期。
fn date_role(lines:&[OcrLine],idx:usize,f:&OcrFieldDefinition)->Option<DateRole>{
    static DATE:OnceLock<(Regex,Regex)>=OnceLock::new();
    let (separated,dates)=DATE.get_or_init(||{
        let pattern=r"\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?";
        (Regex::new(pattern).unwrap(),Regex::new(&format!(r"{pattern}|\d{{8}}")).unwrap())
    });
    let line=lines.get(idx)?;
    let selected=rule_value(&line.text,f).or_else(||{
        let anchor=matching_anchor(&line.text,&f.anchors)?;
        rule_value(line.text.split_once(anchor)?.1.trim_start_matches(['：',':',' ']),f)
    })?;
    // 与 format_value 一致：优先匹配带分隔符日期，不能把它前面的八位编号当日期。
    let (date_start,date_end)=separated.find(selected).map(|date|(date.start(),date.end())).or_else(||{
        (selected.chars().all(|c|c.is_ascii_digit()||c.is_whitespace())&&selected.chars().filter(|c|!c.is_whitespace()).count()==8).then_some((0,selected.len()))
    })?;
    // selected 是原文的切片，保留正则捕获组选中第二个日期时的真实位置。
    let start=selected.as_ptr() as usize-line.text.as_ptr() as usize;
    if let Some(role)=date_label(&line.text[..start+date_start]){return Some(role);}
    let suffix=&line.text[start+date_end..];
    if !dates.is_match(suffix){if let Some(role)=date_label(suffix){return Some(role);}}
    let bounds=rect(line);
    if let Some((left,_,_,_))=bounds{
        let nearest=lines.iter().enumerate().filter(|(i,near)|*i!=idx&&near.page==line.page&&is_same_row(line,near)&&!dates.is_match(&near.text))
            .filter_map(|(_,near)|{let (_,_,right,_)=rect(near)?;let role=date_label(&near.text)?;(right<=left+20.0).then_some(((left-right).abs(),role))})
            .min_by(|a,b|a.0.total_cmp(&b.0));
        if let Some((_,role))=nearest{return Some(role);}
    }
    for prev in (0..idx).rev().take(3){
        let near=&lines[prev];if near.page!=line.page{break;}
        if dates.is_match(&near.text){continue;}
        if let (Some((l,t,r,b)),Some((nl,_,nr,nb)))=(bounds,rect(near)){
            let height=(b-t).max(10.0);
            if nb>t+height*0.25||t-nb>height*3.0||nr<l||nl>r{continue;}
        }
        if let Some(role)=date_label(&near.text){return Some(role);}
    }
    None
}

fn field_has_regions(p:&OcrProfile,f:&OcrFieldDefinition)->bool{
    p.regions.iter().any(|r|r.field_key.as_deref()==Some(f.key.as_str()))
}

fn in_field_region(line:&OcrLine,p:&OcrProfile,f:&OcrFieldDefinition)->bool{
    if !field_has_regions(p,f){return true;}
    let Some([width,height])=line.page_size else{return false};
    if !width.is_finite()||!height.is_finite()||width<=0.0||height<=0.0{return false;}
    let Some((l,t,r,b))=rect(line)else{return false};
    let (x,y)=((l+r)/2.0/width,(t+b)/2.0/height);
    p.regions.iter().any(|area|area.field_key.as_deref()==Some(f.key.as_str())&&(area.page==0||area.page==line.page)
        &&x>=area.x&&x<=area.x+area.width&&y>=area.y&&y<=area.y+area.height)
}

fn local_for_profile(lines:&[OcrLine],p:&OcrProfile,f:&OcrFieldDefinition)->Vec<(usize,String)>{
    if !field_has_regions(p,f){return local_for(p,lines,f);}
    let has_geometry=lines.iter().any(|l|l.page_size.is_some()&&rect(l).is_some());
    if !has_geometry{return vec![];}
    let scoped=lines.iter().map(|line|{let mut l=line.clone();if !in_field_region(line,p,f){l.text.clear();}l}).collect::<Vec<_>>();
    // 框是硬指令：框内行不因“像打印/导出时间戳”被否决，用户画在哪就取哪。
    let found=local_for_allowing_print_stamp(p,&scoped,f);
    if !found.is_empty(){return found;}
    // 用户画框已表达字段物理归属。单值与多值字段均支持在画框内按行提取有效内容：
    // 1. 所有候选统一执行前缀清理、pattern 正则和格式化，正则不匹配就拒绝；
    // 2. 未配置 pattern 时，提取框内非噪声且可通过格式化的有效文本行；
    // 3. 同一行若有多个单元格在框内（如画框横跨相邻列），严格过滤掉位于右侧的副列单元格，仅保留主列；
    // 4. 严格尊重 multiple 与 max_items 上限，并去重。
    let mut seen = HashSet::new();
    let mut region_found: Vec<(usize, String)> = Vec::new();

    let is_right_column_peer = |idx: usize, line: &OcrLine| -> bool {
        let Some((cur_l, _, _, _)) = rect(line) else { return false; };
        scoped.iter().enumerate().any(|(j, peer)| {
            j != idx && peer.page == line.page && is_same_row(line, peer) && !peer.text.trim().is_empty()
                && rect(peer).is_some_and(|(pl, _, _, _)| pl + 20.0 < cur_l)
        })
    };

    for (i, l) in scoped.iter().enumerate() {
        if l.text.trim().is_empty() { continue; }
        if is_rejected_candidate(Some(p), f, &l.text) { continue; }
        if f.kind == "date" && date_role(lines, i,f)==Some(DateRole::Expiry) { continue; }
        if is_right_column_peer(i, l) { continue; }
        if let Some(val) = format_value(&l.text, f) {
            if is_rejected_candidate(Some(p), f, &val) { continue; }
            if seen.insert(val.clone()) {
                region_found.push((i, val));
                if region_found.len() >= (if f.multiple { f.max_items } else { 1 }) {
                    break;
                }
            }
        }
    }

    if !region_found.is_empty() { return region_found; }
    // 硬约束：区域内找不到就不回退整页，由上层标复核。
    vec![]
}

// 只传脱敏后的证据。几何关系是线索，不把疑似分节行直接判定成业务角色。
fn rule_value<'a>(raw:&'a str,f:&OcrFieldDefinition)->Option<&'a str>{
    let mut s=raw.trim();
    if let Some(prefix)=f.strip_prefixes.iter().filter(|prefix|!prefix.is_empty()&&s.starts_with(prefix.as_str())).max_by_key(|prefix|prefix.len()){
        s=s[prefix.len()..].trim_start_matches(|c:char|c.is_whitespace()||"\u{ff1a}:".contains(c));
    }
    if s.is_empty(){return None;}
    if !f.pattern.is_empty(){
        let re=Regex::new(&f.pattern).ok()?;
        let captures=re.captures(&s)?;
        s=captures.get(1).or_else(||captures.get(0))?.as_str().trim();
        if s.is_empty(){return None;}
    }
    Some(s)
}
pub fn format_value(raw:&str,f:&OcrFieldDefinition)->Option<String>{
    let mut s=rule_value(raw,f)?.to_owned();
    match f.kind.as_str(){
        "date"=>{let s=s.chars().filter(|c|!c.is_whitespace()).collect::<String>();let r=Regex::new(r"(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?").unwrap();let d=if let Some(c)=r.captures(&s){chrono::NaiveDate::from_ymd_opt(c[1].parse().ok()?,c[2].parse().ok()?,c[3].parse().ok()?)}else{chrono::NaiveDate::parse_from_str(&s,"%Y%m%d").ok()}?;Some(d.format(if f.format.is_empty(){"%Y%m%d"}else{&f.format}).to_string())},
        "number"=>{let normalized=s.replace([',','\u{ff0c}',' '],"");let r=Regex::new(r"[-+]?\d+(?:\.\d+)?").unwrap();let matches:Vec<_>=r.find_iter(&normalized).collect();if matches.len()!=1{return None;}let raw=matches[0].as_str();if f.format.is_empty(){Some(raw.into())}else{let n:f64=raw.parse().ok()?;if !n.is_finite(){return None;}Some(format!("{:.*}",f.format.parse::<usize>().ok()?,n))}},
        _=>{
            let next_labels=if is_customer_field(f){
                &["供方", "供应商", "卖方", "备注"][..]
            }else if f.key.contains("供方")||f.key.contains("卖方"){
                &["客户", "买方", "需方", "备注"][..]
            }else{&[][..]};
            if let Some(pos)=next_labels.iter().filter_map(|label|s.find(label)).filter(|pos|*pos>0).min(){s.truncate(pos);}
            let s=s.trim();if s.is_empty(){None}else{Some(s.to_owned())}
        },
    }
}

fn is_same_row(a:&OcrLine,b:&OcrLine)->bool{
    if a.r#box.len()<4||b.r#box.len()<4{return false;}
    let ya=(a.r#box[0][1]+a.r#box[2][1])/2.0;let yb=(b.r#box[0][1]+b.r#box[2][1])/2.0;
    let ha=(a.r#box[2][1]-a.r#box[0][1]).abs().max(10.0);
    (ya-yb).abs()<ha*0.75
}

fn numeric_char(c:char)->bool{c.is_numeric()||numeric_cn(c)}

#[cfg(test)]
fn local(lines:&[OcrLine],f:&OcrFieldDefinition)->Vec<(usize,String)>{local_for(&blank_profile(),lines,f)}

/// 用户把字段框在打印/导出时间戳上时以画框为准，不做这层否决。
fn local_for_allowing_print_stamp(profile:&OcrProfile,lines:&[OcrLine],f:&OcrFieldDefinition)->Vec<(usize,String)>{local_for_impl(profile,lines,f,false)}

fn local_for(profile:&OcrProfile,lines:&[OcrLine],f:&OcrFieldDefinition)->Vec<(usize,String)>{local_for_impl(profile,lines,f,true)}

fn local_for_impl(profile:&OcrProfile,lines:&[OcrLine],f:&OcrFieldDefinition,skip_print_stamp:bool)->Vec<(usize,String)>{
    let noisy = |s:&str| is_rejected_candidate(Some(profile),f,s);
    let bad_date=|i:usize|match date_role(lines,i,f){Some(DateRole::Expiry)=>true,Some(DateRole::Print)=>skip_print_stamp,_=>false};
    let mut found=vec![];
    let col_cands = table_column_candidates_for(profile,lines,f);
    if !col_cands.is_empty(){
        for i in col_cands{
            if let Some(v)=format_value(&lines[i].text,f){if !found.iter().any(|(_,x)|x==&v){found.push((i,v));}}
            if found.len()>=if f.multiple{f.max_items}else{1}{break;}
        }
        return found;
    }
    if f.anchors.is_empty()&&f.pattern.is_empty(){return found;}
    let is_prod=f.key.contains("产品")||f.key.contains("品名")||f.key.contains("物料");
    let is_cust=is_customer_field(f);
    let is_date=f.kind=="date"||f.key.contains("日期");
    for(i,l)in lines.iter().enumerate(){
        if !f.anchors.is_empty(){
            if is_cust&&noisy(&l.text){continue;}
            let Some(a)=matching_anchor(&l.text,&f.anchors)else{continue};
            let value=l.text.split_once(a).unwrap().1.trim_start_matches(|c:char|c.is_whitespace()||"\u{ff1a}:".contains(c)).to_owned();
            if !value.is_empty(){
                if !noisy(&value){
                    if let Some(v)=format_value(&value,f){
                        if (!is_date||!bad_date(i))&&!found.iter().any(|(_,x)|x==&v){
                            found.push((i,v));
                        }
                        if found.len()>=if f.multiple{f.max_items}else{1}{break;}
                    }
                }
                continue;
            }
            let mut neighbors = vec![];
            for (k, cand) in lines.iter().enumerate() {
                if k != i && cand.page == l.page && is_same_row(l, cand) {
                    neighbors.push(k);
                }
            }
            for k in (i + 1)..lines.len().min(i + 8) {
                if lines[k].page == l.page && !neighbors.contains(&k) {
                    neighbors.push(k);
                }
            }
            if i > 0 {
                for k in (i.saturating_sub(2)..i).rev() {
                    if lines[k].page == l.page && !neighbors.contains(&k) {
                        neighbors.push(k);
                    }
                }
            }
            for j in neighbors {
                let cand=&lines[j];
                let same_row=is_same_row(l,cand);
                let raw=cand.text.trim();
                if noisy(raw){continue;}
                if raw.contains(['：',':'])&&matching_anchor(raw,&f.anchors).is_none(){continue;}
                if same_row&&is_prod{continue;}
                if is_cust&&(raw.starts_with("供方")||raw.starts_with("卖方")){continue;}
                if is_prod{
                    let is_num=raw.chars().all(|c|numeric_char(c)||c.is_whitespace()||".,-+/\u{ffe5}$".contains(c));
                    if is_num||raw.len()<=1{continue;}
                }
                if let Some(v)=format_value(raw,f){
                    if !noisy(&v)&&(!is_date||!bad_date(j))&&!found.iter().any(|(_,x)|x==&v){found.push((j,v));}
                    if found.len()>=if f.multiple{f.max_items}else{1}{break;}
                }
            }
            if found.len()>=if f.multiple{f.max_items}else{1}{break;}
        }else{
            if !noisy(&l.text){
                if let Some(v)=format_value(&l.text,f){
                    if noisy(&v){continue;}
                    if (!is_date||!bad_date(i))&&!found.iter().any(|(_,x)|x==&v){found.push((i,v));}
                    if found.len()>=if f.multiple{f.max_items}else{1}{break;}
                }
            }
        }
    }found
}

pub fn extract(lines:&[OcrLine],p:&OcrProfile,logs:&mut Vec<String>)->(BTreeMap<String,OcrFieldResult>,Vec<OcrDecisionLog>){
    let mut out=BTreeMap::new();let mut decisions=Vec::new();
    for f in &p.fields{
        let mut local_cand=None;let mut local_matched=None;
        let mut result=OcrFieldResult{value:String::new(),source:"missing".into(),confidence:None,evidence:vec![],review:false};
        let mut reasons:Vec<String>=vec![];
        let candidates=local_for_profile(lines,p,f);
        if !candidates.is_empty(){
            let value=candidates.iter().map(|(_,v)|v.clone()).collect::<Vec<_>>().join(&f.separator);
            local_cand=Some(value.clone());local_matched=candidates.iter().find_map(|(i,_)|matching_anchor(&lines[*i].text,&f.anchors).map(str::to_owned));
            result.value=value;result.source="local".into();
            result.evidence=candidates.iter().map(|(i,_)|*i).collect();

            let avg_score = if result.evidence.is_empty() { 0.95 } else {
                result.evidence.iter().map(|&i| lines[i].score).sum::<f64>() / result.evidence.len() as f64
            };
            result.confidence = Some((avg_score * 100.0).round() / 100.0);

            let any_low_score = result.evidence.iter().any(|i| lines[*i].score < p.threshold);

            if any_low_score {
                result.review = true;
                reasons.push("OCR 识别质量偏低，需人工核对".into());
            } else if f.anchors.is_empty() && f.pattern.is_empty() {
                result.review = true;
                reasons.push("区域内独立值缺少定位标签或格式规则，请核对字段归属".into());
            } else {
                result.review = false;
            }
            logs.push(format!("[决策: {}] 采纳本地规则提取：{} (置信度: {:?})",f.key,result.value,result.confidence));
        }
        if result.value.is_empty(){
            result.value=f.fallback.clone();result.source="missing".into();result.review=f.required||!f.fallback.is_empty();
            if f.required{reasons.push("必填字段未识别到内容".into());}
        }
        // 区域是硬约束：命中区域的本地结果若已高分放行则直接采信；否则标复核，
        // 不再悄悄回退整页取别处的值（local_for_profile 内部已限定作用域）。
        if field_has_regions(p,f){
            let confident_local = result.source == "local" && result.confidence.unwrap_or(0.0) >= 0.85 && !result.value.is_empty() && !result.review;
            if !confident_local {
                result.review=true;
                reasons.push(if lines.iter().any(|line|in_field_region(line,p,f)){
                    "区域内缺少可靠的字段匹配，请核对字段归属".into()
                }else{
                    "绑定区域内未找到可用文字，请核对版式、页码和区域；旧识别结果需重新识别".into()
                });
            }
        }
        logs.push(format!("[最终: {}] value=\"{}\" source={} confidence={:?} review={}",f.key,result.value,result.source,result.confidence,result.review));
        decisions.push(OcrDecisionLog{field_key:f.key.clone(),final_value:result.value.clone(),final_source:result.source.clone(),review_required:result.review,review_reason:if !result.review{None}else if reasons.is_empty(){None}else{Some(reasons.join("；"))},local_attempted:Some(true),local_candidate:local_cand,local_rule_matched:local_matched});
        out.insert(f.key.clone(),result);
    }
    (out,decisions)
}
pub fn filename(p:&OcrProfile,fields:&BTreeMap<String,OcrFieldResult>,path:&str)->String{filename_with_warning(p,fields,path).0}
pub fn filename_with_warning(p:&OcrProfile,fields:&BTreeMap<String,OcrFieldResult>,path:&str)->(String,String){
    let path=Path::new(path);let stem=path.file_stem().unwrap_or_default().to_string_lossy();let mut name=p.filename_pattern.replace("{原文件名}",&stem);
    for(k,v)in fields{name=name.replace(&format!("{{{k}}}"),&v.value);}
    let ext=path.extension().unwrap_or_default().to_string_lossy();if name.to_lowercase().ends_with(&format!(".{}",ext.to_lowercase())){name.truncate(name.len()-ext.len()-1);}
    // Normalize only the generated filename. OCR values and exports keep their
    // original text; deterministic character replacement does not require review.
    let invalid=|c:char|c.is_control()||"\\/:*?\"<>|".contains(c)||matches!(c,'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{feff}');
    name=name.chars().map(|c|if invalid(c){'_'}else{c}).collect::<String>().trim_matches([' ','.']).to_owned();
    let mut warnings=vec![];if name.encode_utf16().count()>140{warnings.push("生成名称过长，已截断；请核对关键信息");}
    let mut length=0;name=name.chars().take_while(|c|{length+=c.len_utf16();length<=140}).collect();
    let base=name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    if name.is_empty(){name="未命名".into();}
    if ["CON","PRN","AUX","NUL","CLOCK$","CONIN$","CONOUT$"].contains(&base.as_str())||["COM","LPT"].iter().any(|prefix|base.strip_prefix(prefix).is_some_and(|n|["1","2","3","4","5","6","7","8","9","¹","²","³"].contains(&n))){name.insert(0,'_');}
    (format!("{}.{}",name.trim_end_matches([' ','.']),ext),warnings.join("；"))
}

fn normalize_match_text(text:&str)->String{
    let width=text.chars().map(|c|match c{
        '\u{3000}'=>' ',
        '\u{ff01}'..='\u{ff5e}'=>char::from_u32(c as u32-0xfee0).unwrap(),
        _=>c,
    }).collect::<String>().to_lowercase();
    let cjk=|c:char|matches!(c,'\u{3400}'..='\u{4dbf}'|'\u{4e00}'..='\u{9fff}'|'\u{20000}'..='\u{2fa1f}');
    let mut chars=width.chars().peekable();
    let mut normalized=String::new();
    while let Some(c)=chars.next(){
        if c==' '{
            let mut spaces=1;
            while chars.peek()==Some(&' '){chars.next();spaces+=1;}
            // Only ordinary spaces between Han characters in one OCR line.
            // Never join lines/blocks, tab-separated fields, or Latin words.
            if spaces==1&&normalized.chars().next_back().is_some_and(cjk)&&chars.peek().copied().is_some_and(cjk){continue;}
            normalized.extend(std::iter::repeat_n(' ',spaces));
        }else{normalized.push(c);}
    }
    normalized.trim().to_owned()
}

pub fn diagnose_profile_match<'a>(profiles:&'a[OcrProfile],lines:&[OcrLine])->(Option<&'a OcrProfile>,OcrProfileMatch){
    let probe=lines.iter().enumerate().filter(|(_,line)|line.page==1)
        .map(|(index,line)|(index,normalize_match_text(&line.text),
            if line.score.is_finite()&&(0.0..=1.0).contains(&line.score){Some(line.score)}else{None}))
        .collect::<Vec<_>>();
    let candidates=profiles.iter().map(|profile|{
        let mut seen=HashSet::new();
        let keywords=profile.keywords.iter().filter_map(|keyword|{
            let normalized=normalize_match_text(keyword);
            if normalized.is_empty()||!seen.insert(normalized.clone()){return None;}
            // The strongest occurrence suffices to reproduce this keyword's vote;
            // retain its index and score, never copy document bodies into diagnostics.
            let hits=probe.iter().filter(|(_,text,_)|text.contains(&normalized))
                .max_by(|a,b|a.2.unwrap_or(-1.0).total_cmp(&b.2.unwrap_or(-1.0)))
                .map(|(index,_,score)|OcrKeywordHit{line_index:*index,score:*score,
                    accepted:score.is_some_and(|score|score>=profile.threshold)})
                .into_iter().collect();
            Some(OcrKeywordMatch{keyword:keyword.clone(),normalized,hits})
        }).collect::<Vec<_>>();
        let score=keywords.iter().filter(|keyword|keyword.hits.iter().any(|hit|hit.accepted)).count();
        OcrProfileCandidate{profile_id:profile.id.clone(),profile_name:profile.name.clone(),threshold:profile.threshold,score,keywords}
    }).collect::<Vec<_>>();
    let highest=candidates.iter().map(|candidate|candidate.score).max().unwrap_or(0);
    let winners=candidates.iter().enumerate().filter(|(_,candidate)|highest>0&&candidate.score==highest).map(|(index,_)|index).collect::<Vec<_>>();
    let selected=if winners.len()==1{Some(&profiles[winners[0]])}else{None};
    let (outcome,message)=if let Some(profile)=selected{
        ("matched",format!("已唯一匹配配置“{}”（命中 {highest} 个关键词）",profile.name))
    }else if candidates.iter().all(|candidate|candidate.keywords.is_empty()){
        ("no_keywords","已保存的配置均未设置自动匹配关键词，请填写关键词并保存后重试；配置名称和附加标题不参与匹配。".into())
    }else if probe.is_empty(){
        ("no_text","首页未识别出文字，请检查首页或手动选择配置后重试。".into())
    }else if winners.len()>1{
        ("tied",format!("{} 个配置并列最高分（各命中 {highest} 个关键词），请设置更有区分度的关键词，或手动选择配置。",winners.len()))
    }else if candidates.iter().any(|candidate|candidate.keywords.iter().any(|keyword|!keyword.hits.is_empty())){
        ("low_confidence","首页含匹配关键词，但相关行分数无效或低于对应配置阈值；请核对识别文字与分数，或手动选择配置。".into())
    }else{
        ("no_match","首页未命中已保存的自动匹配关键词；请核对关键词并保存。关键词仅在后续页或被拆成多行/多块时，请手动选择配置。".into())
    };
    (selected,OcrProfileMatch{outcome:outcome.into(),message,page:1,dpi:200,lines_count:probe.len(),candidates,probe_region:None})
}

#[cfg(test)]
pub fn match_profile<'a>(profiles:&'a[OcrProfile],lines:&[OcrLine])->Option<&'a OcrProfile>{
    diagnose_profile_match(profiles,lines).0
}
