use crate::{AppState, assistant_context::{self, TaskContext}};
use serde_json::{json,Value};
use std::collections::BTreeMap;

fn escape(s:&str)->String{s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&#39;")}
fn text(value:&Value)->String{value.as_str().map(str::to_owned).unwrap_or_else(||if value.is_null(){"未知".into()}else{value.to_string()})}
pub(crate) fn label(key:&str)->&str{match key{"roots"=>"工作目录","theme"=>"主题","recursive"=>"默认递归","launchers"=>"快捷工具","modelConfigured"=>"模型已配置","schemaVersion"=>"配置格式版本","revision"=>"配置修订","assistantReasoning"=>"助手思考程度","assistantOutputTokens"=>"助手输出上限","assistantTaskTimeoutSecs"=>"任务预算（秒）","modelRequestTimeoutSecs"=>"请求预算（秒）","modelFirstResponseTimeoutSecs"=>"首响应等待（秒）","modelIdleTimeoutSecs"=>"输出停滞等待（秒）","modelRetryCount"=>"请求重试次数","assistantToolRounds"=>"工具轮数上限","assistantHistoryMessages"=>"历史消息条数","assistantHistoryChars"=>"每条历史字符上限","assistantSearchLimit"=>"联网搜索次数上限","assistantContinueTokens"=>"续写额度","assistantAutoContinue"=>"自动续写","modelContextTokens"=>"上下文容量","translationReasoning"=>"翻译思考程度","translationOutputTokens"=>"翻译输出上限","tavilyEnabled"=>"联网搜索开关","jevEnabled"=>"评分开关","filter"=>"默认筛选","modelTemperature"=>"温度","modelTopP"=>"采样范围",_=>key}}
fn table(source:&Value,fields:&[String])->String{
    let columns=if fields.is_empty(){vec!["name".into(),"created".into(),"modified".into(),"parent".into()]}else{fields.to_vec()};
    let mut html="<div class=table-scroll><table><thead><tr>".to_owned();
    for f in &columns{html.push_str(&format!("<th>{}</th>",escape(assistant_context::field_label(f))));}html.push_str("</tr></thead><tbody>");
    for row in source["items"].as_array().into_iter().flatten(){html.push_str("<tr>");for f in &columns{html.push_str(&format!("<td>{}</td>",escape(&assistant_context::field_text(row,f))));}html.push_str("</tr>");}
    html.push_str("</tbody></table></div>");html
}
fn tree(source:&Value)->String{
    let mut parents=BTreeMap::<String,Vec<&Value>>::new();
    for row in source["items"].as_array().into_iter().flatten(){parents.entry(text(&row["parent"])).or_default().push(row);}
    fn branch(parent:&str,parents:&BTreeMap<String,Vec<&Value>>,depth:usize)->String{
        if depth>128{return "<li>层级过深，以下内容省略</li>".into();}
        let mut html="<ul class=tree>".to_owned();
        for row in parents.get(parent).into_iter().flatten(){let path=text(&row["path"]);let children=parents.contains_key(&path);html.push_str("<li>");
            if children{html.push_str(&format!("<details{}><summary title=\"{}\">{}</summary>{}</details>",if depth<2{" open"}else{""},escape(&path),escape(&text(&row["name"])),branch(&path,parents,depth+1)));}
            else{html.push_str(&format!("<span title=\"{}\">{}</span>",escape(&path),escape(&text(&row["name"]))));}html.push_str("</li>");}
        html.push_str("</ul>");html
    }
    if let Some(root)=source["scope"]["root"].as_str(){return format!("<p class=muted>{}</p>{}",escape(root),branch(root,&parents,0));}
    let roots=parents.keys().filter(|p|!source["items"].as_array().into_iter().flatten().any(|r|r["path"].as_str()==Some(p.as_str()))).cloned().collect::<Vec<_>>();
    roots.into_iter().map(|root|format!("<h3>{}</h3>{}",escape(&root),branch(&root,&parents,0))).collect()
}
fn source_html(source:&Value,layout:&str,fields:&[String])->String{
    if source["items"].is_array(){return if layout=="tree"{tree(source)}else{table(source,fields)};}
    if source["results"].is_array(){return source["results"].as_array().unwrap().iter().map(|r|format!("<article><h3>{}</h3><p>{}</p><p class=muted>{}</p><a href=\"{}\" rel=\"noreferrer noopener\">查看来源</a></article>",escape(&text(&r["title"])),escape(&text(&r["content"])),escape(&text(&r["publishedDate"])),escape(&crate::tavily::public_url(r["url"].as_str().unwrap_or("")).unwrap_or_default()))).collect();}
    let mut html="<table><thead><tr><th>项目</th><th>当前值</th></tr></thead><tbody>".to_owned();
    for (key,value) in source.as_object().into_iter().flatten(){if ["evidenceId","evidenceKind","modelUrl","modelId"].contains(&key.as_str())||key.to_lowercase().contains("key")||key.to_lowercase().contains("secret"){continue;}
        html.push_str(&format!("<tr><th>{}</th><td>{}</td></tr>",escape(label(key)),escape(&text(value))));}
    html.push_str("</tbody></table>");html
}
pub fn create(state:&AppState,current:&TaskContext,args:&Value,trace:&[Value],workspace:Option<&str>)->Result<Value,String>{
    let title=args["title"].as_str().unwrap_or("工作台报告");let summary=args["summary"].as_str().unwrap_or("");
    if title.len()>1000||summary.len()>20_000{return Err("报告标题或说明过长".into());}
    let mut sources=BTreeMap::<String,Value>::new();
    if let Some(refs)=args["sourceRefs"].as_array(){if refs.len()>32{return Err("报告来源过多".into());}for id in refs{let id=id.as_str().ok_or("报告来源标识无效")?;let source=assistant_context::evidence(state,&current.session_id,id)?;
        if !["metadata","settings_read","app_get_state","web_search","user"].contains(&source["evidenceKind"].as_str().unwrap_or("")){return Err("报告来源类型未授权".into());}sources.insert(id.into(),source);}}
    if let Some(index)=args["sourceCall"].as_u64(){let record=trace.get(index as usize).ok_or("报告来源不存在")?;
        if !["files_search","files_query","files_analyze","directory_tree","resultset_enrich","files_list_dirs","files_missing_companion","settings_read","app_get_state","web_search"].contains(&record["tool"].as_str().unwrap_or("")){return Err("报告来源类型未授权".into());}
        let result=&record["result"];let source=if let Some(id)=result["evidenceId"].as_str(){assistant_context::evidence(state,&current.session_id,id)?}else{result.clone()};sources.insert("sourceCall".into(),if source.is_array(){json!({"items":source})}else{source});}
    if sources.is_empty(){return Err("报告需要本会话的授权资料来源".into());}
    for source in sources.values(){if let Some(root)=source["scope"]["root"].as_str(){state.index.authorize(root)?;}}
    let mut body=format!("<h1>{}</h1><p>{}</p>",escape(title),escape(summary));
    let blocks=args["blocks"].as_array();
    if let Some(blocks)=blocks{if blocks.len()>100{return Err("报告章节过多".into());}for block in blocks{
        let heading=block["title"].as_str().unwrap_or("");if !heading.is_empty(){body.push_str(&format!("<h2>{}</h2>",escape(heading)));}
        match block["type"].as_str().unwrap_or("text"){
            "text"=>body.push_str(&format!("<p>{}</p>",escape(block["text"].as_str().unwrap_or("")))),
            "list"=>{body.push_str("<ul>");for item in block["items"].as_array().into_iter().flatten(){body.push_str(&format!("<li>{}</li>",escape(&text(item))));}body.push_str("</ul>");},
            "source"|"table"|"tree"|"metrics"|"chart"=>{let source=sources.get(block["sourceRef"].as_str().unwrap_or("")).ok_or("章节引用了未声明的资料来源")?;
                let fields=block["fields"].as_array().map(|f|f.iter().filter_map(|f|f.as_str().map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
                if block["type"]=="metrics"{body.push_str(&format!("<p class=metric>{} 项</p>",source["total"].as_u64().unwrap_or(0)));}
                else if block["type"]=="chart"{let groups=source["groups"].as_array().ok_or("该来源没有可绘制的分组数据")?;let max=groups.iter().filter_map(|g|g["count"].as_u64()).max().unwrap_or(1).max(1);for group in groups.iter().take(200){body.push_str(&format!("<div class=bar><span>{}</span><meter min=0 max={} value={}></meter><b>{}</b></div>",escape(&text(&group["label"])),max,group["count"].as_u64().unwrap_or(0),group["count"].as_u64().unwrap_or(0)));}}
                else{body.push_str(&source_html(source,if block["type"]=="tree"{"tree"}else{"table"},&fields));}},
            _=>return Err("报告包含不支持的内容块".into()),
        }
    }}else{for source in sources.values(){body.push_str(&source_html(source,args["layout"].as_str().unwrap_or("table"),&current.intent.fields));}}
    body.push_str("<footer><h2>资料与范围</h2>");
    for (id,source) in &sources{body.push_str(&format!("<p>{} · {} · {}</p>",escape(id),escape(source["evidenceKind"].as_str().unwrap_or("本轮工具结果")),escape(source["scope"]["root"].as_str().unwrap_or("授权资料"))));
        if source["scope"]["indexScanning"]==true{body.push_str("<p>索引仍在更新，本报告覆盖当前已索引范围。</p>");}
        if source["results"].is_array(){body.push_str("<p>公开资料基于搜索摘要整理，未读取网页全文。</p>");for r in source["results"].as_array().unwrap(){if let Some(url)=r["url"].as_str().and_then(crate::tavily::public_url){body.push_str(&format!("<p><a href=\"{}\" rel=\"noreferrer noopener\">{}</a></p>",escape(&url),escape(&text(&r["title"]))));}}}
    }body.push_str("</footer>");
    let html=format!("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>{}</title><style>body{{font:14px system-ui;color:#263025;max-width:1100px;margin:32px auto;padding:0 24px;line-height:1.8}}h1{{font-size:28px}}h2{{margin-top:30px}}p,td{{white-space:pre-wrap;overflow-wrap:anywhere}}table{{border-collapse:collapse;width:100%}}th,td{{padding:9px;border-bottom:1px solid #dce1d7;text-align:left;vertical-align:top}}th{{background:#f2f5ee}}a{{color:#456829}}.table-scroll{{overflow:auto}}.tree{{list-style:none;padding-left:20px;border-left:1px solid #dce1d7}}summary{{cursor:pointer}}.muted,footer{{color:#65715f;font-size:12px}}footer{{border-top:1px solid #dce1d7;margin-top:30px}}.metric{{font-size:32px}}.bar{{display:flex;gap:12px;align-items:center}}.bar span{{width:160px}}meter{{flex:1}}</style><main>{}</main></html>",escape(title),body);
    crate::assistant_tools::save_html(state,workspace,title,&html)
}
