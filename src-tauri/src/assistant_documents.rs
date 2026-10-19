use serde::Deserialize;
use serde_json::Value;
use std::io::{Cursor,Read,Write};
use zip::{ZipArchive,ZipWriter,write::SimpleFileOptions};

const XML:&str="<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
const REL:&str="http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL:&str="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
fn escape(text:&str)->String{text.chars().filter(|c|*c>=' '||matches!(c,'\n'|'\r'|'\t')).collect::<String>().replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&apos;")}
fn relationships(items:&[(&str,String)])->String{format!("{XML}<Relationships xmlns=\"{REL}\">{}</Relationships>",items.iter().enumerate().map(|(i,(kind,target))|format!("<Relationship Id=\"rId{}\" Type=\"{OFFICE_REL}/{kind}\" Target=\"{}\"/>",i+1,escape(target))).collect::<String>())}
fn content_types(parts:&[(&str,&str)])->String{format!("{XML}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>{}</Types>",parts.iter().map(|(path,kind)|format!("<Override PartName=\"/{path}\" ContentType=\"application/vnd.openxmlformats-officedocument.{kind}+xml\"/>")).collect::<String>())}
fn package(parts:Vec<(String,String)>)->Result<Vec<u8>,String>{
    let mut zip=ZipWriter::new(Cursor::new(Vec::new()));
    for (name,text) in parts{zip.start_file(name,SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|_|"文档封装失败")?;zip.write_all(text.as_bytes()).map_err(|_|"文档封装失败")?;}
    Ok(zip.finish().map_err(|_|"文档封装失败")?.into_inner())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Slide{pub title:String,pub bullets:Vec<String>}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document{
    pub filename:String,pub format:String,pub title:String,
    #[serde(default)] pub paragraphs:Vec<String>,#[serde(default)] pub columns:Vec<String>,
    #[serde(default)] pub rows:Vec<Vec<String>>,#[serde(default)] pub slides:Vec<Slide>,
}
impl Document{
    pub fn parse(args:Value)->Result<Self,String>{
        if args["format"]=="html"&&args["paragraphs"].as_array().is_some_and(|p|p.iter().any(|v|v.as_str().is_some_and(crate::assistant_html::is_html_document))){return Err("document_create 仅生成静态文档，不能把整份 HTML 源码当正文保存。交互网页或游戏请使用 html_app_create；用户须先在助理设置中单独确认交互 HTML 风险。".into());}
        if args.to_string().len()>250_000{return Err("文档内容过多，请分批生成".into());}
        let doc:Self=serde_json::from_value(args).map_err(|_|"文件内容结构无效：请使用标题、文字段落、文字单元格或幻灯片要点")?;
        let path=crate::assistant_fs::relative_path(&doc.filename)?;
        if path.components().count()!=1||crate::assistant_fs::extension(&path)?!=doc.format||!["txt","docx","xlsx","html","pptx","pdf"].contains(&doc.format.as_str()){return Err("文件名扩展名需要与 TXT、DOCX、XLSX、HTML、PPTX、PDF 格式一致，不支持子目录写入".into());}
        if doc.title.trim().is_empty()||doc.title.len()>500||doc.paragraphs.len()>200||doc.paragraphs.iter().any(|s|s.len()>8000)||doc.rows.len()>500||doc.columns.len()>30||doc.rows.iter().any(|r|r.len()>30||r.iter().any(|c|c.len()>4000))||doc.columns.iter().any(|c|c.len()>500){return Err("标题、段落或表格超过安全上限（200段、500行、30列）".into());}
        if doc.slides.len()>30||doc.slides.iter().any(|s|s.title.trim().is_empty()||s.title.chars().count()>60||s.title.contains(['\n','\r'])||s.bullets.len()>6||s.bullets.iter().any(|b|b.chars().count()>100||b.contains(['\n','\r']))){return Err("PPT最多30页，每页标题及要点为单行，最多6条、每条100字；长内容请拆成多页".into());}
        if doc.format=="pptx"&&doc.slides.is_empty(){return Err("PPT需要提供至少一页标题和要点".into());}
        if (doc.format=="pptx"&&(!doc.paragraphs.is_empty()||!doc.rows.is_empty()||!doc.columns.is_empty()))||(doc.format!="pptx"&&!doc.slides.is_empty()){return Err("PPT内容请全部放入 slides；其他文件不能混入 slides，避免内容丢失".into());}
        if doc.format=="xlsx"&&(!doc.columns.is_empty()||!doc.rows.is_empty())&&!doc.paragraphs.is_empty(){return Err("Excel请把全部内容放入列名和单元格，不要同时传入文字段落".into());}Ok(doc)
    }
    pub fn preview(&self)->String{
        let mut text=format!("{}\n",self.title);
        for p in &self.paragraphs{text.push_str(p);text.push('\n');}
        if !self.rows.is_empty()||!self.columns.is_empty(){text.push_str(&format!("\n表格：{}行，{}列\n",self.rows.len(),self.columns.len().max(self.rows.iter().map(Vec::len).max().unwrap_or(0))));text.push_str(&self.columns.join(" | "));for row in &self.rows{text.push('\n');text.push_str(&row.join(" | "));}}
        if !self.slides.is_empty(){text.push_str(&format!("\n幻灯片：{}页\n",self.slides.len()));for slide in &self.slides{text.push_str(&slide.title);text.push('\n');text.push_str(&slide.bullets.join("\n"));text.push('\n');}}
        text
    }
    pub fn render(&self)->Result<Vec<u8>,String>{match self.format.as_str(){
        "txt"=>{let mut text=self.title.clone()+"\n\n"+&self.paragraphs.join("\n\n");if !self.columns.is_empty(){text.push_str("\n\n");text.push_str(&self.columns.join("\t"));}for row in &self.rows{text.push('\n');text.push_str(&row.join("\t"));}Ok(text.into_bytes())},
        "html"=>Ok(self.html().into_bytes()),"docx"=>self.docx(),"xlsx"=>self.xlsx(),"pptx"=>self.pptx(),_=>Err("不支持的文件格式".into())}}
    pub fn html(&self)->String{
        let mut body=format!("<h1>{}</h1>",escape(&self.title));for paragraph in &self.paragraphs{body.push_str(&format!("<p>{}</p>",escape(paragraph)));}
        if !self.rows.is_empty()||!self.columns.is_empty(){body.push_str("<table>");if !self.columns.is_empty(){body.push_str("<thead><tr>");for col in &self.columns{body.push_str(&format!("<th>{}</th>",escape(col)));}body.push_str("</tr></thead>");}body.push_str("<tbody>");for row in &self.rows{body.push_str("<tr>");for cell in row{body.push_str(&format!("<td>{}</td>",escape(cell)));}body.push_str("</tr>");}body.push_str("</tbody></table>");}
        format!("<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font:16px system-ui;max-width:980px;margin:48px auto;padding:0 24px;color:#263025;line-height:1.8}}h1{{font-size:32px}}p,td{{white-space:pre-wrap;overflow-wrap:anywhere}}table{{border-collapse:collapse;width:100%;margin:24px 0}}th,td{{padding:12px;border:1px solid #dde3d9;text-align:left}}th{{background:#edf3e8}}@media print{{body{{max-width:none;margin:0;padding:0}}table{{table-layout:fixed;font-size:10px}}th,td{{padding:4px}}}}</style></head><body>{body}</body></html>",escape(&self.title))
    }
    fn docx(&self)->Result<Vec<u8>,String>{
        let paragraph=|text:&str,title:bool|format!("<w:p><w:r><w:rPr><w:rFonts w:ascii=\"Calibri\" w:eastAsia=\"Microsoft YaHei\"/>{}<w:sz w:val=\"{}\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",if title{"<w:b/>"}else{""},if title{36}else{22},escape(text));
        let mut body=paragraph(&self.title,true);for p in &self.paragraphs{for line in p.lines(){body.push_str(&paragraph(line,false));}body.push_str("<w:p/>");}
        if !self.rows.is_empty()||!self.columns.is_empty(){let width=self.columns.len().max(self.rows.iter().map(Vec::len).max().unwrap_or(1));body.push_str("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>");for side in ["top","left","bottom","right","insideH","insideV"]{body.push_str(&format!("<w:{side} w:val=\"single\" w:sz=\"4\" w:color=\"D9E0D4\"/>"));}body.push_str("</w:tblBorders></w:tblPr><w:tblGrid>");for _ in 0..width{body.push_str("<w:gridCol w:w=\"2000\"/>");}body.push_str("</w:tblGrid>");
            for (header,row) in std::iter::once((true,&self.columns)).filter(|(_,r)|!r.is_empty()).chain(self.rows.iter().map(|r|(false,r))){body.push_str("<w:tr>");for i in 0..width{body.push_str("<w:tc>");body.push_str(&paragraph(row.get(i).map(String::as_str).unwrap_or(""),header));body.push_str("</w:tc>");}body.push_str("</w:tr>");}body.push_str("</w:tbl>");}
        body.push_str("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr>");
        package(vec![("[Content_Types].xml".into(),content_types(&[("word/document.xml","wordprocessingml.document.main")])),("_rels/.rels".into(),relationships(&[("officeDocument","word/document.xml".into())])),("word/document.xml".into(),format!("{XML}<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"))])
    }
    fn xlsx(&self)->Result<Vec<u8>,String>{
        let mut rows=vec![];if !self.columns.is_empty(){rows.push(self.columns.clone());}rows.extend(self.rows.clone());if rows.is_empty(){rows.push(vec![self.title.clone()]);rows.extend(self.paragraphs.iter().map(|p|vec![p.clone()]));}
        let mut data=String::new();for (index,row) in rows.iter().enumerate(){data.push_str(&format!("<row r=\"{}\">",index+1));for (col,cell) in row.iter().enumerate(){let label=column(col);data.push_str(&format!("<c r=\"{label}{}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",index+1,escape(cell)));}data.push_str("</row>");}
        package(vec![("[Content_Types].xml".into(),content_types(&[("xl/workbook.xml","spreadsheetml.sheet.main"),("xl/worksheets/sheet1.xml","spreadsheetml.worksheet")])),("_rels/.rels".into(),relationships(&[("officeDocument","xl/workbook.xml".into())])),("xl/_rels/workbook.xml.rels".into(),relationships(&[("worksheet","worksheets/sheet1.xml".into())])),("xl/workbook.xml".into(),format!("{XML}<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"{OFFICE_REL}\"><sheets><sheet name=\"内容\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>")),("xl/worksheets/sheet1.xml".into(),format!("{XML}<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><cols><col min=\"1\" max=\"30\" width=\"24\" customWidth=\"1\"/></cols><sheetData>{data}</sheetData></worksheet>"))])
    }
    fn pptx(&self)->Result<Vec<u8>,String>{
        let ns="xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
        let group="<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";
        let ids=self.slides.iter().enumerate().map(|(i,_)|format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>",i+256,i+2)).collect::<String>();
        let mut rels=vec![("slideMaster","slideMasters/slideMaster1.xml".into())];for i in 0..self.slides.len(){rels.push(("slide",format!("slides/slide{}.xml",i+1)));}
        let mut parts=vec![("_rels/.rels".into(),relationships(&[("officeDocument","ppt/presentation.xml".into())])),("ppt/presentation.xml".into(),format!("{XML}<p:presentation {ns}><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>")),("ppt/_rels/presentation.xml.rels".into(),relationships(&rels)),("ppt/slideMasters/slideMaster1.xml".into(),format!("{XML}<p:sldMaster {ns}><p:cSld><p:spTree>{group}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>")),("ppt/slideMasters/_rels/slideMaster1.xml.rels".into(),relationships(&[("slideLayout","../slideLayouts/slideLayout1.xml".into()),("theme","../theme/theme1.xml".into())])),("ppt/slideLayouts/slideLayout1.xml".into(),format!("{XML}<p:sldLayout {ns} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>")),("ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(),relationships(&[("slideMaster","../slideMasters/slideMaster1.xml".into())])),("ppt/theme/theme1.xml".into(),theme())];
        let mut types=vec![("ppt/presentation.xml".into(),"presentationml.presentation.main"),("ppt/slideMasters/slideMaster1.xml".into(),"presentationml.slideMaster"),("ppt/slideLayouts/slideLayout1.xml".into(),"presentationml.slideLayout"),("ppt/theme/theme1.xml".into(),"theme")];
        for (i,slide) in self.slides.iter().enumerate(){let title=shape(2,&slide.title,600000,400000,11000000,1200000,32,true);let bullets=shape(3,&slide.bullets.iter().map(|b|format!("• {b}")).collect::<Vec<_>>().join("\n"),600000,1750000,11000000,4600000,if slide.bullets.iter().any(|b|b.chars().count()>60){14}else{20},false);let name=format!("ppt/slides/slide{}.xml",i+1);types.push((name.clone(),"presentationml.slide"));parts.push((name,format!("{XML}<p:sld {ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"F8FAF5\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>{group}{title}{bullets}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>")));parts.push((format!("ppt/slides/_rels/slide{}.xml.rels",i+1),relationships(&[("slideLayout","../slideLayouts/slideLayout1.xml".into())])));}
        parts.push(("[Content_Types].xml".into(),content_types(&types.iter().map(|(p,t)|(p.as_str(),*t)).collect::<Vec<_>>())));package(parts)
    }
}
pub fn reject_credentials(text:&str)->Result<(),String>{
    static PATTERN:std::sync::OnceLock<regex::Regex>=std::sync::OnceLock::new();
    let pattern=PATTERN.get_or_init(||regex::Regex::new(r#"(?im)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|密码|密钥|口令)[\s"']*[:=：][\s"']*[a-z0-9_-]{8,}"#).unwrap());
    if pattern.is_match(text){return Err("文件内容含疑似密钥、密码或私钥，已阻止发送给模型；请先制作不含凭据的副本".into());}Ok(())
}
fn column(mut n:usize)->String{let mut s=String::new();loop{s.insert(0,(b'A'+(n%26) as u8) as char);if n<26{break;}n=n/26-1;}s}
fn shape(id:u32,text:&str,x:u32,y:u32,w:u32,h:u32,size:u32,bold:bool)->String{
    let mut paragraphs=text.lines().map(|line|format!("<a:p><a:pPr><a:spcAft><a:spcPts val=\"1000\"/></a:spcAft></a:pPr><a:r><a:rPr lang=\"zh-CN\" sz=\"{}\" b=\"{}\"><a:solidFill><a:srgbClr val=\"263025\"/></a:solidFill><a:latin typeface=\"Calibri\"/><a:ea typeface=\"Microsoft YaHei\"/></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"zh-CN\" sz=\"{}\"/></a:p>",size*100,u8::from(bold),escape(line),size*100)).collect::<String>();if paragraphs.is_empty(){paragraphs="<a:p/>".into();}
    format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Text {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap=\"square\"><a:spAutoFit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>")
}
fn theme()->String{
    let colors=[("dk1","263025"),("lt1","FFFFFF"),("dk2","456829"),("lt2","F8FAF5"),("accent1","6B8951"),("accent2","D8A956"),("accent3","6A8CA8"),("accent4","A77F91"),("accent5","729A91"),("accent6","AF926D"),("hlink","386FAD"),("folHlink","7A5B95")].iter().map(|(name,color)|format!("<a:{name}><a:srgbClr val=\"{color}\"/></a:{name}>")).collect::<String>();
    let fill="<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";let line=format!("<a:ln w=\"9525\">{fill}<a:prstDash val=\"solid\"/></a:ln>");
    format!("{XML}<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office\"><a:themeElements><a:clrScheme name=\"Office\">{colors}</a:clrScheme><a:fontScheme name=\"Office\"><a:majorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"Microsoft YaHei\"/><a:cs typeface=\"\"/></a:majorFont><a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"Microsoft YaHei\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Office\"><a:fillStyleLst>{}</a:fillStyleLst><a:lnStyleLst>{}</a:lnStyleLst><a:effectStyleLst>{}</a:effectStyleLst><a:bgFillStyleLst>{}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>",fill.repeat(3),line.repeat(3),"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3),fill.repeat(3))
}

pub fn read_text(ext:&str,data:&[u8])->Result<(String,bool),String>{
    let (text,partial)=if ["docx","xlsx","pptx"].contains(&ext){office_text(ext,data)?}else{(String::from_utf8(data.to_vec()).map_err(|_|"文本不是 UTF-8 编码，请另存为 UTF-8 后读取")?.trim_start_matches('\u{feff}').to_owned(),false)};
    let truncated=partial||text.chars().count()>40_000;Ok((text.chars().take(40_000).collect(),truncated))
}
fn part(archive:&mut ZipArchive<Cursor<&[u8]>>,name:&str)->Result<String,String>{
    let mut file=archive.by_name(name).map_err(|_|"Office 文档结构无效或缺少内容")?;
    if file.size()>2_000_000||file.size()>file.compressed_size().max(1)*200{return Err("文档内部数据过大或压缩比异常，拒绝解压".into());}
    let mut data=vec![];file.by_ref().take(2_000_001).read_to_end(&mut data).map_err(|_|"文档内容读取失败")?;
    if data.len()>2_000_000{return Err("文档内部数据过大".into());}String::from_utf8(data).map_err(|_|"文档 XML 编码无效".into())
}
fn xml_values(xml:&str,names:&[&str])->Result<String,String>{
    use quick_xml::{Reader,events::Event};let mut reader=Reader::from_str(xml);let mut value=String::new();let mut selected=0usize;
    loop{match reader.read_event().map_err(|_|"文档 XML 结构无效")?{
        Event::DocType(_)=>return Err("不读取含外部实体或 DTD 的文档".into()),
        Event::Start(tag)=>{if names.contains(&tag.local_name().as_ref()){selected+=1;}},
        Event::End(tag)=>{if names.contains(&tag.local_name().as_ref()){selected=selected.saturating_sub(1);value.push(' ');}if ["p","row","si"].contains(&tag.local_name().as_ref()){value.push('\n');}},
        Event::Text(text) if selected>0=>{value.push_str(&quick_xml::escape::unescape(text.as_ref()).map_err(|_|"文档实体无效")?);},
        Event::GeneralRef(reference) if selected>0=>{value.push_str(&quick_xml::escape::unescape(&format!("&{};",reference.as_ref())).map_err(|_|"文档含不支持的实体")?);},
        Event::CData(text) if selected>0=>value.push_str(text.as_ref()),
        Event::Eof=>break,_=>(),
    }}Ok(value)
}
fn office_text(ext:&str,data:&[u8])->Result<(String,bool),String>{
    let eocd=data.windows(4).rposition(|w|w==b"PK\x05\x06").ok_or("Office 文档缺少目录信息")?;
    if eocd+22>data.len()||u16::from_le_bytes([data[eocd+10],data[eocd+11]])>2000{return Err("文档内部文件过多或使用了不支持的 ZIP64".into());}
    let mut archive=ZipArchive::new(Cursor::new(data)).map_err(|_|"不是可读取的标准 Office 文档")?;
    if archive.len()>2000{return Err("文档内部文件过多".into());}
    if archive.file_names().any(|n|n.to_ascii_lowercase().ends_with("vbaproject.bin")){return Err("不读取带有宏的 Office 文档".into());}
    if ext=="docx"{return Ok((xml_values(&part(&mut archive,"word/document.xml")?,&["t"])?,false));}
    let mut result=String::new();let mut partial;
    if ext=="xlsx"{
        let shared=if archive.file_names().any(|n|n=="xl/sharedStrings.xml"){shared_strings(&part(&mut archive,"xl/sharedStrings.xml")?)?}else{vec![]};
        let mut names=archive.file_names().filter(|n|n.starts_with("xl/worksheets/sheet")&&n.ends_with(".xml")).map(str::to_owned).collect::<Vec<_>>();names.sort_by_key(|n|n.trim_start_matches("xl/worksheets/sheet").trim_end_matches(".xml").parse::<u32>().unwrap_or(0));partial=names.len()>32;
        for name in names.into_iter().take(32){result.push_str(&format!("\n工作表 {name}（只读缓存值，公式不计算，缓存可能过期）：\n"));result.push_str(&sheet_text(&part(&mut archive,&name)?,&shared)?);if result.len()>200_000{partial=true;break;}}
    }else{let mut names=archive.file_names().filter(|n|n.starts_with("ppt/slides/slide")&&n.ends_with(".xml")).map(str::to_owned).collect::<Vec<_>>();names.sort_by_key(|n|n.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse::<u32>().unwrap_or(0));partial=names.len()>30;for name in names.into_iter().take(30){result.push_str(&format!("\n{name}\n"));result.push_str(&xml_values(&part(&mut archive,&name)?,&["t"])?);if result.len()>200_000{partial=true;break;}}}
    Ok((result,partial))
}
fn shared_strings(xml:&str)->Result<Vec<String>,String>{
    use quick_xml::{Reader,events::Event};let mut reader=Reader::from_str(xml);let mut items=vec![];let mut current=String::new();let mut in_text=false;
    loop{match reader.read_event().map_err(|_|"共享文字结构无效")?{
        Event::DocType(_)=>return Err("不读取含 DTD 的文档".into()),
        Event::Start(tag)=>{if tag.local_name().as_ref()=="si"{current.clear();}if tag.local_name().as_ref()=="t"{in_text=true;}},
        Event::End(tag)=>{if tag.local_name().as_ref()=="t"{in_text=false;}if tag.local_name().as_ref()=="si"{items.push(current.clone());}},
        Event::Text(text) if in_text=>current.push_str(&quick_xml::escape::unescape(text.as_ref()).map_err(|_|"文档实体无效")?),
        Event::GeneralRef(reference) if in_text=>current.push_str(&quick_xml::escape::unescape(&format!("&{};",reference.as_ref())).map_err(|_|"文档实体无效")?),
        Event::CData(text) if in_text=>current.push_str(text.as_ref()),Event::Eof=>break,_=>(),
    }}Ok(items)
}
fn sheet_text(xml:&str,shared:&[String])->Result<String,String>{
    use quick_xml::{Reader,events::Event};let mut reader=Reader::from_str(xml);let mut result=String::new();let mut cell=String::new();let mut kind=String::new();let mut value=String::new();let mut in_value=false;let mut formula=false;
    loop{match reader.read_event().map_err(|_|"工作表结构无效")?{
        Event::DocType(_)=>return Err("不读取含 DTD 的工作表".into()),
        Event::Start(tag)=>match tag.local_name().as_ref(){"c"=>{cell.clear();kind.clear();value.clear();formula=false;for attr in tag.attributes(){let attr=attr.map_err(|_|"单元格属性无效")?;match attr.key.as_ref(){"r"=>cell=attr.value.as_ref().to_owned(),"t"=>kind=attr.value.as_ref().to_owned(),_=>()}}},"v"|"t"=>in_value=true,"f"=>formula=true,_=>()},
        Event::End(tag)=>match tag.local_name().as_ref(){"v"|"t"=>in_value=false,"c"=>{let text=if kind=="s"{shared.get(value.parse::<usize>().map_err(|_|"共享文字索引无效")?).ok_or("共享文字索引越界")?.clone()}else if kind=="b"{if value=="1"{"TRUE".into()}else{"FALSE".into()}}else if formula&&value.is_empty(){"[公式没有缓存结果]".into()}else{value.clone()};result.push_str(&format!("[{cell}] {text}\t"));},"row"=>result.push('\n'),_=>()},
        Event::Text(text) if in_value=>value.push_str(&quick_xml::escape::unescape(text.as_ref()).map_err(|_|"单元格实体无效")?),
        Event::GeneralRef(reference) if in_value=>value.push_str(&quick_xml::escape::unescape(&format!("&{};",reference.as_ref())).map_err(|_|"单元格实体无效")?),
        Event::CData(text) if in_value=>value.push_str(text.as_ref()),Event::Eof=>break,_=>(),
    }}Ok(result)
}

#[cfg(test)]
mod tests{
    use super::*;
    use serde_json::json;
    #[test]
    fn whole_html_is_not_a_document_paragraph(){
        let error=Document::parse(json!({"filename":"game.html","format":"html","title":"game","paragraphs":[format!("<!doctype html><html><body>{}</body></html>","x".repeat(9000))]})).err().unwrap();
        assert!(error.contains("html_app_create"));
    }
    #[test]
    fn passive_document_formats_and_access_inputs(){
        for unsafe_name in ["../private.txt","C:\\private.txt","file.txt:secret","CON.txt","COM¹.txt",".env","a\u{202e}b.txt"]{assert!(crate::assistant_fs::relative_path(unsafe_name).is_err());}
        assert!(crate::assistant_fs::relative_path("资料/说明.docx").is_ok());
        for format in ["txt","docx","xlsx","html","pptx"]{
            let args=if format=="pptx"{json!({"filename":"说明.pptx","format":format,"title":"A & B","slides":[{"title":"A & B","bullets":["<script>仅为文字</script>"]}]})}else{json!({"filename":format!("说明.{format}"),"format":format,"title":"A & B","paragraphs":["<script>仅为文字</script>"]})};
            let document=Document::parse(args).unwrap();let bytes=document.render().unwrap();
            if format=="html"{let html=String::from_utf8(bytes).unwrap();assert!(html.contains("&lt;script&gt;"));assert!(!html.contains("<script>"));assert!(html.contains("default-src 'none'"));}
            else if format!="txt"{let mut archive=ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();assert!(archive.by_name("[Content_Types].xml").is_ok());for index in 0..archive.len(){let mut file=archive.by_index(index).unwrap();let mut xml=String::new();file.read_to_string(&mut xml).unwrap();let mut reader=quick_xml::Reader::from_str(&xml);while !matches!(reader.read_event().unwrap(),quick_xml::events::Event::Eof){}assert!(!xml.contains("vbaProject"));}}
        }
        let doc=Document::parse(json!({"filename":"表格.xlsx","format":"xlsx","title":"表格","columns":["值"],"rows":[["=HYPERLINK(\"https://example.invalid\")"]]})).unwrap();
        let bytes=doc.render().unwrap();let mut archive=ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();let sheet=part(&mut archive,"xl/worksheets/sheet1.xml").unwrap();assert!(sheet.contains("inlineStr"));assert!(!sheet.contains("<f>"));assert!(read_text("xlsx",&bytes).unwrap().0.contains("HYPERLINK"));
        assert!(reject_credentials("-----BEGIN PRIVATE KEY-----").is_err());
        assert_eq!(xml_values("<p><t>A &amp; B</t></p>",&["t"]).unwrap().trim(),"A & B");
    }
}
