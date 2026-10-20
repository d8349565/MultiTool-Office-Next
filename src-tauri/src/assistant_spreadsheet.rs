use std::{collections::{HashMap,HashSet},io::Cursor};
use quick_xml::{Reader,Writer,events::{BytesStart,BytesText,Event}};
use serde::Deserialize;
use serde_json::Value;
use zip::{ZipArchive,ZipWriter};

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Translation{
    pub source_filename:String,pub filename:String,pub title:String,pub translations:Vec<CellTranslation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CellTranslation{pub sheet:String,pub cell:String,pub text:String}
impl Translation{
    pub fn parse(args:Value)->Result<Self,String>{
        if args.to_string().len()>250_000{return Err("翻译内容过多，请缩小表格范围后重试".into());}
        let value:Self=serde_json::from_value(args).map_err(|_|"Excel 翻译参数无效")?;
        let name=crate::assistant_fs::relative_path(&value.filename)?;
        if name.components().count()!=1||crate::assistant_fs::extension(&name)?!="xlsx"{return Err("译文必须新建为工作目录根部的 .xlsx 文件".into());}
        if value.title.trim().is_empty()||value.title.len()>500||value.translations.is_empty()||value.translations.len()>2000||value.translations.iter().any(|c|c.text.len()>8000||c.text.chars().any(|ch|ch<' '&&!matches!(ch,'\n'|'\r'|'\t'))){return Err("翻译需要标题及 1～2000 个文字单元格，每格最多 8 KB，且不能含 XML 控制字符".into());}
        Ok(value)
    }
    pub fn preview(&self)->String{
        let mut text=format!("{}\n源文件：{}\n在副本中替换 {} 个文字单元格；保留工作表、样式、合并单元格、行列尺寸、数字和公式。文字变长可能需要调整行高或列宽；被替换单元格的富文本统一为普通文字。\n",self.title,self.source_filename,self.translations.len());
        for c in &self.translations{text.push_str(&format!("\n{} [{}] {}",c.sheet,c.cell,c.text));}text
    }
}
fn attribute(tag:&BytesStart<'_>,key:&str)->Result<String,String>{
    for attr in tag.attributes(){let attr=attr.map_err(|_|"Excel 单元格属性无效")?;if attr.key.as_ref()==key{return attr.normalized_value(quick_xml::XmlVersion::Implicit1_0).map(|v|v.into_owned()).map_err(|_|"Excel 属性编码无效".into());}}
    Ok(String::new())
}
fn replace_cell(xml:&str,text:&str)->Result<String,String>{
    let mut reader=Reader::from_str(xml);let mut writer=Writer::new(Vec::new());let mut replaced=false;let mut depth=0usize;
    loop{
        let event=reader.read_event().map_err(|_|"Excel 单元格 XML 无效")?;
        match &event{
            Event::DocType(_)=>return Err("不处理含 DTD 的工作表".into()),
            Event::Start(tag) if depth==0=>{
                let kind=attribute(tag,"t")?;
                if !["s","inlineStr","str"].contains(&kind.as_str()){return Err("只能翻译文字单元格，不能改写数字或公式".into());}
                let mut start=tag.to_owned();start.clear_attributes();
                for attr in tag.attributes(){let attr=attr.map_err(|_|"单元格属性无效")?;if attr.key.as_ref()!="t"{start.push_attribute(attr);}}
                start.push_attribute(("t","inlineStr"));writer.write_event(Event::Start(start)).map_err(|e|e.to_string())?;depth=1;continue;
            },
            Event::Start(tag)|Event::Empty(tag) if tag.local_name().as_ref()=="f"=>return Err("不能改写公式单元格".into()),
            Event::Start(tag)|Event::Empty(tag) if depth==1&&["v","is"].contains(&tag.local_name().as_ref())=>{
                if !replaced{
                    let name=tag.name().as_ref().to_owned();
                    let prefix=name.rsplit_once(':').map_or("",|(prefix,_)|prefix);
                    let qualified=|name:&str|if prefix.is_empty(){name.to_owned()}else{format!("{prefix}:{name}")};
                    let is_name=qualified("is");let t_name=qualified("t");let mut t=BytesStart::new(t_name.as_str());t.push_attribute(("xml:space","preserve"));
                    for event in [Event::Start(BytesStart::new(is_name.as_str())),Event::Start(t),Event::Text(BytesText::new(text)),Event::End(quick_xml::events::BytesEnd::new(t_name.as_str())),Event::End(quick_xml::events::BytesEnd::new(is_name.as_str()))]{writer.write_event(event).map_err(|e|e.to_string())?;}
                    replaced=true;
                }
                if matches!(event,Event::Start(_)){reader.read_to_end(tag.name()).map_err(|_|"文字单元格结构无效")?;}continue;
            },
            Event::Start(_)=>depth+=1,
            Event::End(_)=>depth=depth.saturating_sub(1),
            Event::Eof=>break,_=>(),
        }
        writer.write_event(event).map_err(|e|e.to_string())?;
    }
    if !replaced{return Err("文字单元格没有可替换的内容".into());}
    String::from_utf8(writer.into_inner()).map_err(|_|"单元格编码无效".into())
}
fn translate_sheet(xml:&str,cells:&HashMap<&str,&str>)->Result<String,String>{
    let mut reader=Reader::from_str(xml);let mut result=String::new();let mut copied=0;let mut found=HashSet::new();
    loop{
        let start=reader.buffer_position() as usize;
        match reader.read_event().map_err(|_|"工作表 XML 无效")?{
            Event::DocType(_)=>return Err("不处理含 DTD 的工作表".into()),
            Event::Start(tag) if tag.local_name().as_ref()=="c"=>{
                let cell=attribute(&tag,"r")?;
                if let Some(text)=cells.get(cell.as_str()){
                    if !found.insert(cell.clone()){return Err("工作表中存在重复的单元格地址".into());}
                    reader.read_to_end(tag.name()).map_err(|_|"单元格结构无效")?;let end=reader.buffer_position() as usize;
                    result.push_str(&xml[copied..start]);result.push_str(&replace_cell(&xml[start..end],text)?);copied=end;
                }
            },
            Event::Eof=>break,_=>(),
        }
    }
    if found.len()!=cells.len(){return Err("译文包含源工作表中不存在的单元格；请使用读取结果中的真实地址".into());}
    result.push_str(&xml[copied..]);Ok(result)
}
pub fn translate(data:&[u8],request:&Translation)->Result<Vec<u8>,String>{
    let mut archive=ZipArchive::new(Cursor::new(data)).map_err(|_|"Excel 文档结构无效")?;
    if archive.file_names().any(|name|{let name=name.to_ascii_lowercase();["vbaproject","xl/macrosheets/","xl/dialogsheets/","xl/activex/","xl/embeddings/","xl/externallinks/","xl/connections.xml","xl/querytables/","_xmlsignatures/"].iter().any(|part|name.contains(part))}){return Err("含宏、嵌入对象、外部数据连接或数字签名的 Excel 暂不支持保留布局翻译，请先另存为普通 XLSX".into());}
    // 使用已经确认读取的同一份字节；未改动的 ZIP 成员原样复制，保留版式和公式。
    let mut sheets:HashMap<&str,HashMap<&str,&str>>=HashMap::new();
    for cell in &request.translations{
        if !cell.sheet.starts_with("xl/worksheets/sheet")||!cell.sheet.ends_with(".xml")||sheets.entry(&cell.sheet).or_default().insert(&cell.cell,&cell.text).is_some(){return Err("工作表标识无效或翻译单元格重复".into());}
    }
    let mut replacements=HashMap::new();
    for (name,cells) in sheets{replacements.insert(name,translate_sheet(&crate::assistant_documents::part(&mut archive,name)?,&cells)?);}
    let mut writer=ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len(){
        let entry=archive.by_index(index).map_err(|_|"Excel 内部文件不可读")?;let name=entry.name().to_owned();
        if let Some(xml)=replacements.remove(name.as_str()){
            use std::io::Write;
            let options=zip::write::SimpleFileOptions::default().compression_method(entry.compression()).last_modified_time(entry.last_modified().unwrap_or_default());
            writer.start_file(name,options).map_err(|e|e.to_string())?;writer.write_all(xml.as_bytes()).map_err(|e|e.to_string())?;
        }else{writer.raw_copy_file(entry).map_err(|_|"无法保留 Excel 内部文件".to_string())?;}
    }
    let bytes=writer.finish().map_err(|e|e.to_string())?.into_inner();
    if bytes.len()>8_000_000{return Err("译文 Excel 超过 8 MB 上限".into());}Ok(bytes)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn translated_copy_preserves_layout_numbers_formulas_and_other_parts(){
        use std::io::Write;
        let sheet=r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="3" width="22"/></cols><sheetData><row r="1" ht="30"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1"><v>123.45</v></c><c r="C1" t="str"><f>CONCAT(A1,B1)</f><v>缓存值</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>保留文字</t></is></c></row></sheetData><mergeCells><mergeCell ref="A2:B2"/></mergeCells></worksheet>"#;
        let mut zip=ZipWriter::new(Cursor::new(Vec::new()));
        for (name,text) in [("xl/worksheets/sheet1.xml",sheet),("xl/styles.xml","unchanged styles"),("xl/sharedStrings.xml","unchanged shared strings"),("xl/media/image1.png","unchanged image")]{zip.start_file(name,zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(text.as_bytes()).unwrap();}
        let source=zip.finish().unwrap().into_inner();
        let mut request=Translation::parse(serde_json::json!({"sourceFilename":"source.xlsx","filename":"translated.xlsx","title":"译文","translations":[{"sheet":"xl/worksheets/sheet1.xml","cell":"A1","text":"你好 & <世界>"}]})).unwrap();
        let output=translate(&source,&request).unwrap();let mut archive=ZipArchive::new(Cursor::new(output.as_slice())).unwrap();
        let changed=crate::assistant_documents::part(&mut archive,"xl/worksheets/sheet1.xml").unwrap();
        assert!(changed.contains(r#"r="A1" s="3" t="inlineStr""#));assert!(changed.contains("你好 &amp; &lt;世界&gt;"));
        for preserved in [r#"<cols><col min="1" max="3" width="22"/></cols>"#,r#"<c r="B1"><v>123.45</v></c>"#,r#"<c r="C1" t="str"><f>CONCAT(A1,B1)</f><v>缓存值</v></c>"#,r#"<mergeCell ref="A2:B2"/>"#,"保留文字"]{assert!(changed.contains(preserved));}
        assert_eq!(crate::assistant_documents::part(&mut archive,"xl/styles.xml").unwrap(),"unchanged styles");
        assert_eq!(crate::assistant_documents::part(&mut archive,"xl/media/image1.png").unwrap(),"unchanged image");
        for cell in ["B1","C1","Z99"]{request.translations[0].cell=cell.into();assert!(translate(&source,&request).is_err());}
        assert!(replace_cell(r#"<x:c r="A1" t="inlineStr"><x:is><x:t>旧</x:t></x:is></x:c>"#,"新").unwrap().contains("<x:is><x:t"));
    }
}
