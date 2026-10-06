use crate::{AppState, index::{Entry, within}, settings};
use serde_json::{json, Value};
use std::{collections::HashSet, path::{Path, PathBuf}};

pub fn registry() -> Vec<Value> {
    let tool = |name:&str, description:&str, properties:Value, required:Value| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}});
    vec![
        tool("files_list_dirs", "List child directories; metadata only.", json!({"path":{"type":"string"}}), json!(["path"])),
        tool("files_missing_companion", "Find directories missing a matching file in the SAME directory. Case-insensitive. companionName is exact by default, or substring when matchMode=contains; companionExtension optionally restricts extension (e.g. pdf). sourceName is optional: omit to check all directories containing indexed files; provide only for an explicit source/companion relationship. after/before are optional inclusive source modification timestamps; omit both for all time. Creates a complete HTML report without reading document contents. Use current view root unless user specifies another scope.", json!({"sourceName":{"type":"string"},"companionName":{"type":"string"},"matchMode":{"type":"string","enum":["exact","contains"]},"companionExtension":{"type":"string"},"root":{"type":"string"},"after":{"type":"integer"},"before":{"type":"integer"}}), json!(["companionName"])),
        tool("report_create", "Create an escaped, script-free HTML report from a previous files_search, files_list_dirs, or files_missing_companion tool result. sourceCall is the zero-based tool record index. Reports summarize metadata only. Include returned report link in response.", json!({"sourceCall":{"type":"integer"},"title":{"type":"string"},"summary":{"type":"string"}}), json!(["sourceCall","title","summary"])),
        tool("index_refresh", "Request reindexing configured directories.", json!({}), json!([])),
        tool("clipboard_copy", "Copy text, filenames or paths to clipboard when requested by the user. Never reads clipboard or document content.", json!({"text":{"type":"string"}}), json!(["text"])),
        tool("files_reveal", "Locate one or multiple files in Explorer. Pass ALL paths in ONE call; files with the same parent are selected together. Report each group status accurately; selection_requested means OS accepted, not visual confirmation. Never opens file contents.", json!({"paths":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":200}}), json!(["paths"])),
        tool("path_open", "Open a configured file or folder, or reveal it in Explorer, only when user requested this action. Does not return file contents.", json!({"path":{"type":"string"},"reveal":{"type":"boolean"}}), json!(["path"])),
        tool("launcher_run", "Run a configured launcher by id, only when user requested launching it. No arbitrary shell commands.", json!({"id":{"type":"string"}}), json!(["id"]))
    ]
}

fn name(value:&Value,key:&str)->Result<String,String>{
    let s=value[key].as_str().ok_or_else(||format!("缺少 {key}"))?;
    if s.is_empty() || s.contains(['/', '\\', ':']) || s=="." || s==".." {return Err("请输入不含路径的完整文件名".into());}
    Ok(s.into())
}

pub fn missing(state:&AppState,args:&Value,workspace:Option<&str>)->Result<Value,String>{
    missing_with_report(state,args,workspace,true)
}
pub fn missing_with_report(state:&AppState,args:&Value,workspace:Option<&str>,create_report:bool)->Result<Value,String>{
    let source=if args.get("sourceName").is_some(){Some(name(args,"sourceName")?)}else{None}; let companion=name(args,"companionName")?;
    let mode=args["matchMode"].as_str().unwrap_or("exact");if !["exact","contains"].contains(&mode){return Err("无效匹配方式".into());}
    let extension=args["companionExtension"].as_str().unwrap_or("").trim_start_matches('.');
    let after=args.get("after").map(|v|v.as_u64().ok_or("无效起始时间")).transpose()?.unwrap_or(0);
    let before=args.get("before").map(|v|v.as_u64().ok_or("无效截止时间")).transpose()?.unwrap_or(u64::MAX);
    if after>before{return Err("起始时间不能晚于截止时间".into());}
    let generation={let status=state.index.status.lock().unwrap();if status.scanning || !status.errors.is_empty(){return Err("索引正在更新或存在目录错误，暂不能可靠判断缺失。请等待完成或修复索引问题后重试。".into());}status.generation};
    let root=args["root"].as_str().map(|r|state.index.authorize(r)).transpose()?;
    // Take one metadata snapshot, independent of search pagination or model call limits.
    let candidates={
        let roots=state.index.roots.read().unwrap();let entries=state.index.entries.read().unwrap();
        entries.iter().filter(|e|!e.is_dir && source.as_ref().is_none_or(|source|e.name.eq_ignore_ascii_case(source)) && e.modified>=after && e.modified<=before && roots.iter().any(|r|within(Path::new(&e.path),r)) && root.as_ref().is_none_or(|r|within(Path::new(&e.path),r))).cloned().collect::<Vec<_>>()
    };
    let mut seen=HashSet::new();let mut items=vec![];
    for e in candidates {
        if seen.contains(&e.parent){continue;}
        let source_path=state.index.authorize(&e.path)?;
        let current=Entry::from_path(&source_path).ok_or("候选文件已变化或不可访问，请刷新索引后重试")?;
        if current.is_dir || current.modified<after || current.modified>before{continue;}
        seen.insert(e.parent.clone());
        let parent=state.index.authorize(&e.parent)?;
        // Verify names on disk, never open/read document contents; propagate access errors.
        let mut found=false;
        for child in std::fs::read_dir(parent).map_err(|e|format!("无法核对目录：{e}"))? {
            let child=child.map_err(|e|e.to_string())?;
            if matches_companion(&child.file_name().to_string_lossy(),&companion,mode,extension) {
                let kind=child.file_type().map_err(|e|e.to_string())?;
                if kind.is_symlink(){return Err("配套文件为链接，无法在当前范围内确定，请人工核对".into());}
                if kind.is_file(){found=true;}
            }
        }
        if !found{items.push(current);}
    }
    {let status=state.index.status.lock().unwrap();if status.scanning || status.generation!=generation || !status.errors.is_empty(){return Err("核对期间索引发生变化，请重试，避免输出不完整结果".into());}}
    items.sort_by(|a,b|a.parent.cmp(&b.parent));
    let source=source.as_deref().unwrap_or("任意已索引文件");
    let period=if after==0 && before==u64::MAX{"所有时间".to_owned()}else{format!("修改时间 Unix 秒 {after} 至 {before}（含边界）")};
    let summary=format!("{period}，查找 {source} 所在目录缺少 {companion} 的情况。匹配方式：{mode}，扩展名：{extension}，大小写不敏感。PDF 仅按文件名存在性核对，未读取内容，也未判定是否为扫描件。候选来自本地索引；目录存在性核对不是文件系统原子快照。");
    let report=if create_report{write_report(state,workspace,"缺少对应文件的目录",&summary,&items,items.len())?}else{Value::Null};
    Ok(json!({"total":items.len(),"items":items,"previewTruncated":false,"report":report,"criteria":args,"dateField":"source.modified"}))
}

fn matches_companion(filename:&str,pattern:&str,mode:&str,extension:&str)->bool{
    let name_matches=if mode=="contains"{filename.to_lowercase().contains(&pattern.to_lowercase())}else{filename.eq_ignore_ascii_case(pattern)};
    name_matches && (extension.is_empty() || Path::new(filename).extension().and_then(|e|e.to_str()).is_some_and(|e|e.eq_ignore_ascii_case(extension)))
}

fn escape(s:&str)->String{s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&#39;")}
pub fn report_folder(state:&AppState,workspace:Option<&str>)->Result<PathBuf,String>{
    let folder=match workspace {Some(p) if !p.is_empty()=>PathBuf::from(p),_=>state.dir.join("workspace")};
    if !folder.is_absolute(){return Err("报告工作区必须是绝对路径".into());}
    std::fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
    let folder=folder.canonicalize().map_err(|e|e.to_string())?;
    if !folder.is_dir(){return Err("报告工作区必须是文件夹".into());}
    Ok(folder)
}
pub fn write_report(state:&AppState,workspace:Option<&str>,title:&str,summary:&str,items:&[Entry],total:usize)->Result<Value,String>{
    if title.len()>1000 || summary.len()>20_000{return Err("报告标题或说明过长".into());}
    let mut html=format!("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>{}</title><style>body{{font:14px system-ui;margin:32px;line-height:1.7;color:#243024}}table{{border-collapse:collapse;width:100%}}td,th{{padding:8px;border-bottom:1px solid #ddd;text-align:left;overflow-wrap:anywhere}}p{{white-space:pre-wrap}}a{{color:#356622}}</style><h1>{}</h1><p>{}</p><p>本报告列出 {} 条；查询总数 {} 条。仅分析文件元数据。点击目录链接打开目录；浏览器若限制本地链接，可在助手中点击对应目录。</p><table><thead><tr><th>文件</th><th>所在目录</th><th>大小（字节）</th><th>修改时间（Unix 秒）</th></tr></thead><tbody>",escape(title),escape(title),escape(summary),items.len(),total);
    for e in items {
        let display_path=if e.is_dir{&e.path}else{&e.parent};
        let parent=state.index.authorize(display_path)?;
        let url=reqwest::Url::from_directory_path(parent).map_err(|_|"目录链接无效")?;
        html.push_str(&format!("<tr><td>{}</td><td><a href=\"{}\">{}</a></td><td>{}</td><td>{}</td></tr>",escape(&e.name),escape(url.as_str()),escape(display_path),e.size,e.modified));
    }
    html.push_str("</tbody></table></html>");save_html(state,workspace,title,&html)
}
pub fn save_html(state:&AppState,workspace:Option<&str>,title:&str,html:&str)->Result<Value,String>{
    if html.len()>20_000_000||title.len()>1000{return Err("报告内容或标题过长".into());}
    let folder=report_folder(state,workspace)?;let id=uuid::Uuid::new_v4().to_string();let path=folder.join(format!("office-report-{id}.html"));
    settings::atomic_write(&path,html.as_bytes())?;
    if !path.is_file(){return Err("报告未成功落盘".into());}
    let mut reports=state.reports.lock().unwrap();let mut next=reports.clone();next.insert(id.clone(),path.clone());
    settings::atomic_write(&state.dir.join("reports.json"),&serde_json::to_vec(&next).map_err(|e|e.to_string())?)?;*reports=next;
    Ok(json!({"id":id,"title":title,"path":path,"href":format!("office-report:{id}")}))
}

pub fn from_trace(state:&AppState,args:&Value,trace:&[Value],workspace:Option<&str>)->Result<Value,String>{
    let record=trace.get(args["sourceCall"].as_u64().ok_or("缺少工具记录编号")? as usize).ok_or("工具记录不存在")?;
    if !["files_search","files_list_dirs","files_missing_companion"].contains(&record["tool"].as_str().unwrap_or("")){return Err("只能根据文件元数据生成报告".into());}
    if record["result"]["report"].is_object(){return Ok(record["result"]["report"].clone());}
    let result=&record["result"];
    let items:Vec<Entry>=serde_json::from_value(if result.is_array(){result.clone()}else{result["items"].clone()}).map_err(|_|"没有可报告的文件结果")?;
    write_report(state,workspace,args["title"].as_str().unwrap_or("文件分析"),args["summary"].as_str().unwrap_or(""),&items,result["total"].as_u64().unwrap_or(items.len() as u64) as usize)
}

pub fn open_report(state:&AppState,id:&str)->Result<(),String>{
    let reports=state.reports.lock().unwrap();let path=reports.get(id).ok_or("报告已失效，请重新生成")?;
    if Path::new(path).extension().and_then(|s|s.to_str())!=Some("html"){return Err("无效报告".into());}
    open::that_detached(path).map_err(|e|e.to_string())
}
