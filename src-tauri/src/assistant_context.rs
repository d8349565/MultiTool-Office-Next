use crate::{AppState, assistant_work::Request, index::Entry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use rusqlite::OptionalExtension;
use std::path::Path;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", default, deny_unknown_fields)]
pub struct Intent {
    pub relation:String, pub parent_task_id:Option<String>, pub result_set_id:Option<String>,
    pub goal:String, pub operation:String, pub scope:String, pub root:Option<String>,
    pub request:Request, pub fields:Vec<String>, pub delivery:String,
    pub question:String, pub pending_field:String,
    pub resume_operation:String,
    pub allowed_actions:Vec<String>,
    pub needs_tools:bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", default)]
pub struct TaskContext {
    pub schema_version:u32, pub version:u64, pub session_id:String, pub task_id:String,
    pub intent:Intent, pub status:String, pub result_set_ids:Vec<String>,
    pub evidence_ids:Vec<String>,
}
pub fn init(db:&rusqlite::Connection)->Result<(),String>{
    db.execute_batch("CREATE TABLE IF NOT EXISTS assistant_contexts(session TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assistant_evidence(id TEXT PRIMARY KEY,session TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS assistant_evidence_session ON assistant_evidence(session); UPDATE assistant_contexts SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running';").map_err(|e|e.to_string())
}
pub fn session(context:&Value,task:&str)->String{
    context["sessionId"].as_str().filter(|s|!s.is_empty()&&s.len()<=200).unwrap_or(task).to_owned()
}
pub fn load(state:&AppState,session:&str)->Result<TaskContext,String>{
    let raw:Option<String>=state.index.db.lock().unwrap().query_row("SELECT data FROM assistant_contexts WHERE session=?1",[session],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|s|serde_json::from_str(&s).map_err(|_|"会话任务状态无法读取".to_string())).unwrap_or_else(||Ok(TaskContext{session_id:session.into(),schema_version:1,..Default::default()}))
}
pub fn save(state:&AppState,current:&TaskContext)->Result<(),String>{
    let mut db=state.index.db.lock().unwrap();let tx=db.transaction().map_err(|e|e.to_string())?;
    let raw:Option<String>=tx.query_row("SELECT data FROM assistant_contexts WHERE session=?1",[&current.session_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let version=raw.and_then(|s|serde_json::from_str::<TaskContext>(&s).ok()).map_or(0,|c|c.version);
    if current.version!=version+1{return Err("会话状态已更新，请重新核对本轮任务".into());}
    tx.execute("INSERT OR REPLACE INTO assistant_contexts VALUES(?1,?2)",rusqlite::params![current.session_id,serde_json::to_string(current).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
pub fn evidence(state:&AppState,session:&str,id:&str)->Result<Value,String>{
    let raw:Option<String>=if id=="user"{
        state.index.db.lock().unwrap().query_row("SELECT data FROM assistant_evidence WHERE (id=?1 OR kind='user') AND session=?2 ORDER BY rowid DESC LIMIT 1",rusqlite::params![id,session],|r|r.get(0)).optional().map_err(|e|e.to_string())?
    }else{
        state.index.db.lock().unwrap().query_row("SELECT data FROM assistant_evidence WHERE id=?1 AND session=?2",rusqlite::params![id,session],|r|r.get(0)).optional().map_err(|e|e.to_string())?
    };
    let raw=raw.ok_or("结果不存在或不属于本会话")?;
    serde_json::from_str(&raw).map_err(|_|"结果记录无法读取".into())
}
pub fn store_evidence(state:&AppState,session:&str,kind:&str,mut result:Value)->Result<Value,String>{
    let id=uuid::Uuid::new_v4().to_string();result["evidenceId"]=json!(id);
    if result["items"].is_array(){result["resultSetId"]=json!(id);}
    result["evidenceKind"]=json!(kind);
    state.index.db.lock().unwrap().execute("INSERT INTO assistant_evidence VALUES(?1,?2,?3,?4)",rusqlite::params![id,session,kind,result.to_string()]).map_err(|e|e.to_string())?;
    Ok(result)
}
pub fn validate_fields(fields:&mut Vec<String>)->Result<(),String>{
    for f in fields.iter_mut(){if f=="createdAt"{*f="created".into();}if !["name","path","parent","created","modified","businessDate","dateSource","extension","size","isDir"].contains(&f.as_str()){return Err("请求包含不允许读取的字段".into());}}
    fields.sort();fields.dedup();Ok(())
}
pub fn accept(state:&AppState,old:&TaskContext,context:&Value,task:&str,mut intent:Intent)->Result<TaskContext,String>{
    if context["taskContextVersion"].as_u64().is_some_and(|v|v!=old.version){return Err("任务状态版本已变化，请重新打开会话后重试".into());}
    if intent.goal.trim().is_empty()||intent.goal.len()>4000{return Err("任务目标为空或过长".into());}
    if intent.relation.is_empty(){intent.relation="new".into();}
    if intent.scope=="explicit"&&intent.root.is_none(){intent.root=intent.request.root.clone();}
    if intent.relation=="resume"&&old.status=="waiting_input"&&old.intent.pending_field=="scope"&&intent.scope!="result"{intent.result_set_id=None;}
    if !["new","continue","correction","resume"].contains(&intent.relation.as_str())||!["query","enrich","tree","config","report","chat","clarify","failure"].contains(&intent.operation.as_str())||!["","answer","table","html"].contains(&intent.delivery.as_str()){return Err("任务关系、动作或交付形式无效".into());}
    validate_fields(&mut intent.fields)?;
    if intent.allowed_actions.iter().any(|tool|!["files_reveal","path_open","launcher_run","clipboard_copy","index_refresh","text_translate"].contains(&tool.as_str())){return Err("任务请求包含未开放的操作权限".into());}
    if intent.relation!="new"{
        let parent=intent.parent_task_id.as_deref().unwrap_or(&old.task_id);
        if parent.is_empty(){return Err("没有可继续的任务，请明确本轮目标".into());}
        if parent!=old.task_id{
            let previous=crate::task_state::get(state,parent)?;
            if previous["taskContext"]["sessionId"]!=old.session_id{return Err("关联任务不属于本会话".into());}
        }
        intent.parent_task_id=Some(parent.into());
        if intent.result_set_id.is_none()&&["enrich","report"].contains(&intent.operation.as_str()){intent.result_set_id=old.result_set_ids.last().cloned();}
    }else{intent.parent_task_id=None;}
    let mut ids=vec![];
    let frozen=if let Some(id)=&intent.result_set_id{
        match evidence(state,&old.session_id,id){
            Ok(e)=>{ids.push(id.clone());Some(e)},
            Err(_)=>{
                intent.result_set_id=None;
                if intent.operation=="enrich"{intent.operation="chat".into();}
                None
            }
        }
    }else{None};
    if intent.operation=="enrich"&&intent.result_set_id.is_none(){intent.operation="chat".into();}
    if let Some(e)=&frozen{
        let root=e["scope"]["root"].as_str();
        if let Some(root)=root{state.index.authorize(root)?;}
        intent.root=root.map(str::to_owned);intent.scope="result".into();
        if intent.operation=="enrich"{
            let requested=intent.request.clone();intent.request=serde_json::from_value(e["request"].clone()).unwrap_or_default();
            if !requested.sort.is_empty(){intent.request.sort=requested.sort;}
            if !requested.date_field.is_empty(){intent.request.date_field=requested.date_field;}
            if requested.limit.is_some(){intent.request.limit=requested.limit;}
            if requested.latest_only{intent.request.latest_only=true;}
            intent.request.count_only=false;intent.request.offset=requested.offset;
        }
    }else{
        let scope=if intent.scope.is_empty()||intent.scope=="result"{"current"}else{intent.scope.as_str()};
        intent.root=match scope{
            "current"=>context["view"]["currentDirectory"].as_str().or_else(||context["view"]["root"].as_str()).map(str::to_owned),
            "workspace"=>context["view"]["root"].as_str().map(str::to_owned),
            "all"=>{if state.index.roots.read().unwrap().is_empty(){return Err("请先配置工作目录".into());}None},
            "explicit"=>intent.root.clone(),
            _=>return Err("无效目录范围".into()),
        };
        if !["chat","config","failure","clarify"].contains(&intent.operation.as_str())&&scope!="all"&&intent.root.is_none(){return Err("请先在工作区选择目录".into());}
        if let Some(root)=&intent.root{intent.root=Some(state.index.authorize(root)?.to_string_lossy().into_owned());}
        intent.scope=scope.into();
    }
    intent.request.root=intent.root.clone();
    if intent.request.kind.is_empty(){intent.request.kind="file".into();}
    if intent.request.recursive.is_none(){intent.request.recursive=Some(true);}
    if intent.operation=="tree"{intent.request.kind="directory".into();intent.request.count_only=false;}
    if intent.operation=="clarify"&&(intent.question.trim().is_empty()||!["scope","date","goal","field"].contains(&intent.pending_field.as_str())){return Err("澄清问题或待补条件无效".into());}
    let current=TaskContext{schema_version:1,version:old.version+1,session_id:old.session_id.clone(),task_id:task.into(),status:if intent.operation=="clarify"{"waiting_input"}else{"running"}.into(),result_set_ids:ids,evidence_ids:if intent.relation!="new"{old.evidence_ids.clone()}else{vec![]},intent};
    save(state,&current)?;Ok(current)
}
pub fn attach(state:&AppState,current:&mut TaskContext,result:&Value)->Result<(),String>{
    if let Some(id)=result["evidenceId"].as_str(){if !current.evidence_ids.iter().any(|s|s==id){current.evidence_ids.push(id.into());}}
    if let Some(id)=result["resultSetId"].as_str(){if !current.result_set_ids.iter().any(|s|s==id){current.result_set_ids.push(id.into());}}
    current.version+=1;save(state,current)
}
pub fn finish(state:&AppState,current:&mut TaskContext,status:&str)->Result<(),String>{
    current.status=status.into();current.version+=1;save(state,current)
}
pub fn delete_session(state:&AppState,session:&str)->Result<(),String>{
    let current=load(state,session)?;
    if state.tasks.lock().unwrap().contains_key(&current.task_id){return Err("运行中的会话不能删除".into());}
    if state.task_results.lock().unwrap().values().any(|v|v["sessionId"]==session&&v["status"]=="running"){return Err("运行中的会话不能删除".into());}
    let mut db=state.index.db.lock().unwrap();let tx=db.transaction().map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM assistant_contexts WHERE session=?1",[session]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM assistant_evidence WHERE session=?1",[session]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM assistant_tasks WHERE json_extract(data,'$.taskContext.sessionId')=?1 OR json_extract(data,'$.sessionId')=?1",[session]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
pub fn query(state:&AppState,current:&mut TaskContext,request:Request,analysis:bool)->Result<Value,String>{
    validate_fields(&mut current.intent.fields)?;
    let mut full=request.clone();full.offset=0;
    let result=crate::assistant_work::execute_full(&state.index,full,analysis)?;
    let stored=store_evidence(state,&current.session_id,"metadata",result)?;attach(state,current,&stored)?;
    current.intent.request=request.clone();
    page(&stored,request.offset,if request.count_only{0}else{request.limit.unwrap_or(10)},&current.intent.fields)
}
pub fn page(full:&Value,offset:usize,limit:usize,fields:&[String])->Result<Value,String>{
    let mut result=full.clone();let rows=full["items"].as_array().ok_or("结果不是文件集合")?;
    result["items"]=json!(rows.iter().skip(offset).take(limit).collect::<Vec<_>>());
    result["hasMore"]=json!(limit>0&&offset.saturating_add(limit)<rows.len());
    result["nextOffset"]=json!(offset.saturating_add(limit));
    result["request"]["offset"]=json!(offset);result["fields"]=json!(fields);
    result["delivery"]=projection(full,offset,limit,fields);
    Ok(result)
}
pub fn enrich(state:&AppState,current:&mut TaskContext,id:&str,offset:usize)->Result<Value,String>{
    let options=json!(current.intent.request);enrich_with_options(state,current,id,offset,&options)
}
pub fn enrich_with_options(state:&AppState,current:&mut TaskContext,id:&str,offset:usize,options:&Value)->Result<Value,String>{
    validate_fields(&mut current.intent.fields)?;
    let mut result=evidence(state,&current.session_id,id)?;
    let generation=state.index.status.lock().unwrap().generation;let changed=result["scope"]["indexGeneration"].as_u64()!=Some(generation);
    if let Some(rows)=result["items"].as_array_mut(){for row in rows{
        let path=row["path"].as_str().ok_or("结果缺少路径")?.to_owned();
        let allowed=state.index.roots.read().unwrap().iter().any(|root|Path::new(&path).starts_with(root));
        if !allowed{return Err("原结果已不在当前授权范围内".into());}
        if changed&&!Path::new(&path).exists(){row["availability"]=json!("项目已删除或移动，显示原快照");}
        if current.intent.fields.iter().any(|f|row.get(f).is_none()||row[f].is_null()){
            if let Ok(path)=state.index.authorize(&path){if let Some(entry)=Entry::from_path(&path){let latest=serde_json::to_value(entry).map_err(|e|e.to_string())?;
                for field in &current.intent.fields{if row.get(field).is_none()||row[field].is_null(){row[field]=latest[field].clone();}}
            }}
        }
    }}
    result["request"]["countOnly"]=json!(false);result["snapshotChanged"]=json!(changed);
    state.index.db.lock().unwrap().execute("UPDATE assistant_evidence SET data=?1 WHERE id=?2 AND session=?3",rusqlite::params![result.to_string(),id,current.session_id]).map_err(|e|e.to_string())?;
    let original:Request=serde_json::from_value(result["request"].clone()).map_err(|_|"原查询条件无效")?;
    for field in ["sort","dateField","latestOnly","limit"]{if let Some(value)=options.get(field){if !value.is_null(){result["request"][field]=value.clone();}}}
    let request:Request=serde_json::from_value(result["request"].clone()).map_err(|_|"原集合排序参数无效")?;
    let reordered=request.sort!=original.sort||request.date_field!=original.date_field||request.latest_only!=original.latest_only;
    if reordered{crate::assistant_work::order_snapshot(&mut result,&request)?;}
    else if request.limit.is_some_and(|n|n==0||n>50){return Err("每次展示数量必须为 1–50 项".into());}
    if reordered||request.limit!=original.limit{result["sourceResultSetId"]=json!(id);result=store_evidence(state,&current.session_id,"metadata",result)?;attach(state,current,&result)?;}
    current.intent.request=request.clone();
    page(&result,offset,request.limit.unwrap_or(10),&current.intent.fields)
}
pub fn field_text(row:&Value,field:&str)->String{
    let value=&row[field];if value.is_null(){return "未知".into();}
    if ["created","modified"].contains(&field){return value.as_i64().and_then(|n|chrono::DateTime::from_timestamp(n,0)).map(|d|d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or("未知".into());}
    value.as_str().map(str::to_owned).unwrap_or_else(||value.to_string())
}
pub fn field_label(field:&str)->&str{match field{"name"=>"名称","created"=>"系统创建时间","modified"=>"修改时间","businessDate"=>"业务日期","dateSource"=>"日期来源","path"=>"路径","parent"=>"所在目录","extension"=>"格式","size"=>"大小（字节）","isDir"=>"文件夹",_=>field}}
pub fn projection(full:&Value,offset:usize,limit:usize,fields:&[String])->Value{
    if fields.is_empty(){return Value::Null;}
    let mut columns=vec!["name".to_owned()];columns.extend(fields.iter().filter(|f|f.as_str()!="name").cloned());
    json!({"columns":columns.iter().map(|f|json!({"key":f,"label":field_label(f)})).collect::<Vec<_>>(),"rows":full["items"].as_array().into_iter().flatten().skip(offset).take(limit).map(|r|json!({"path":r["path"],"values":columns.iter().map(|f|field_text(r,f)).collect::<Vec<_>>(),"notice":r["availability"]})).collect::<Vec<_>>(),"total":full["total"],"resultSetId":full["resultSetId"]})
}
pub fn delivery_text(result:&Value,current:&TaskContext)->String{
    if !current.intent.fields.is_empty(){return format!("以下展示 {} 项的{}，共 {} 项。{}",result["items"].as_array().map_or(0,Vec::len),current.intent.fields.iter().map(|f|field_label(f)).collect::<Vec<_>>().join("、"),result["total"],if result["snapshotChanged"]==true{"索引发生变化，保留原结果集合；变化项目已标注。"}else{""});}
    crate::assistant_work::answer(result)
}
pub fn validate_delivery(state:&AppState,current:&TaskContext,trace:&[Value])->Result<(),String>{
    if current.intent.delivery=="html"{
        let reports=state.reports.lock().unwrap();
        if !trace.iter().any(|r|{let p=if r["tool"]=="report_create"{&r["result"]}else{&r["result"]["report"]};p["id"].as_str().is_some_and(|id|reports.get(id).is_some_and(|path|path.is_file()))}){return Err("尚未生成并验证本轮要求的网页报告".into());}
    }
    if current.intent.delivery=="table"&&!current.intent.fields.is_empty()&&!trace.iter().any(|r|r["result"]["delivery"]["columns"].as_array().is_some_and(|cols|current.intent.fields.iter().all(|f|cols.iter().any(|c|c["key"]==*f)))){return Err("结果缺少本轮所需字段，不能用数量代替字段表".into());}
    Ok(())
}
