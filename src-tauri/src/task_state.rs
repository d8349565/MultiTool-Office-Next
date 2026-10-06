use crate::AppState;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

pub fn init(db:&rusqlite::Connection)->Result<(),String>{
    crate::assistant_context::init(db)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS assistant_tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL); ").map_err(|e|e.to_string())?;
    let mut stmt=db.prepare("SELECT id,data FROM assistant_tasks").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    for (id,raw) in rows{if let Ok(mut value)=serde_json::from_str::<Value>(&raw){if value["status"]=="running"{
        value["status"]=json!("interrupted");value["fault"]=fault("应用已关闭，上次任务未完成");
        if value["taskContext"].is_object(){value["taskContext"]["status"]=json!("interrupted");}
        db.execute("UPDATE assistant_tasks SET data=?2 WHERE id=?1",rusqlite::params![id,value.to_string()]).map_err(|e|e.to_string())?;
    }}}
    Ok(())
}
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
pub fn fault(message:&str)->Value{
    let (code,recovery)=if message.contains("取消"){("cancelled","重新发送任务")}
        else if message.contains("应用已关闭"){("interrupted","重新发送，或仅整理已有结果")}
        else if message.contains("401")||message.contains("403")||message.contains("密钥"){("authentication","在设置页核对密钥和模型权限后重试")}
        else if message.contains("首响应"){("first_response_timeout","检查服务状态或申请增加首响应等待")}
        else if message.contains("停滞"){("output_stalled","检查网络，或仅整理已有结果")}
        else if message.contains("超")||message.contains("时间")||message.contains("预算"){("timeout","申请调整等待预算，或仅整理已有结果")}
        else if message.contains("提前结束"){("stream_closed","仅整理已有内容，或重新发送")}
        else if message.contains("连接")||message.contains("读取模型"){("connection","检查网络，或重试未完成的请求")}
        else if message.contains("限流")||message.contains("繁忙"){("rate_limit","稍后重试")}

        else if message.contains("400")||message.contains("422"){("unsupported_parameters","检查模型能力与参数，不能悄悄降低思考程度")}
        else{("request_failed","查看错误原因后重试，已完成操作不会自动重放")};
    json!({"code":code,"message":message,"recovery":recovery})
}
fn persist(state:&AppState,id:&str,value:&Value){
    let _=state.index.db.lock().unwrap().execute("INSERT OR REPLACE INTO assistant_tasks(id,data) VALUES(?1,?2)",rusqlite::params![id,value.to_string()]);
}
pub fn start(state:&AppState,id:&str,route:&str,session:&str){
    let value=json!({"id":id,"sessionId":session,"taskContext":crate::assistant_context::load(state,session).ok(),"status":"running","route":route,"startedAt":now(),"deadlineAt":now()+state.settings.lock().unwrap().assistant_task_timeout_secs*1000,"checkpointAt":now(),"activities":[],"trace":[],"usage":[],"text":"","progress":"正在准备任务"});
    persist(state,id,&value);state.task_results.lock().unwrap().insert(id.into(),value);
}
pub fn get(state:&AppState,id:&str)->Result<Value,String>{
    if let Some(value)=state.task_results.lock().unwrap().get(id){return Ok(value.clone());}
    let raw:String=state.index.db.lock().unwrap().query_row("SELECT data FROM assistant_tasks WHERE id=?1",[id],|r|r.get(0)).map_err(|_|"任务记录不存在")?;
    serde_json::from_str(&raw).map_err(|_|"任务记录无法读取".into())
}
pub fn emit(app:&tauri::AppHandle,event:&str,payload:Value){
    if let Some(state)=app.try_state::<std::sync::Arc<AppState>>(){if let Some(id)=payload["id"].as_str(){
        let mut snapshots=state.task_results.lock().unwrap();
        if let Some(s)=snapshots.get_mut(id){
            match event {
                "pi-start"=>s["piRuntime"]=payload.clone(),
                "task-stream"=>s["text"]=payload["text"].clone(),
                "task-progress"=>s["progress"]=payload["message"].clone(),
                "task-usage"=>{s["usage"]=payload["usage"].clone();s["round"]=payload["round"].clone();},
                "task-context"=>s["taskContext"]=payload["taskContext"].clone(),
                "task-activity"=>{let a=&payload["activity"];if let Some(items)=s["activities"].as_array_mut(){if let Some(old)=items.iter_mut().find(|v|v["id"]==a["id"]){*old=a.clone();}else{items.push(a.clone());}}
                    if a["kind"]=="tool"&&!a["result"].is_null(){let trace=s["activities"].as_array().unwrap().iter().filter(|v|v["kind"]=="tool"&&!v["result"].is_null()).map(|v|json!({"tool":v["tool"],"result":v["result"]})).collect::<Vec<_>>();s["trace"]=json!(trace);}},
                _=>{},
            }
            if now().saturating_sub(s["checkpointAt"].as_u64().unwrap_or(0))>=1000 || event=="task-activity"&&payload["activity"]["status"]!="running"{s["checkpointAt"]=json!(now());persist(&state,id,s);}
        }
    }}
    let _=app.emit(event,payload);
}
pub fn finish(state:&AppState,id:&str,result:Result<Value,String>)->Value{
    let mut value=get(state,id).unwrap_or_else(|_|json!({"id":id,"text":"","activities":[],"trace":[],"usage":[]}));
    match result{
        Ok(v)=>{if let Some(map)=v.as_object(){for (k,v) in map{value[k]=v.clone();}}
            if value["status"]=="running"||value["status"].is_null(){value["status"]=json!(if !value["warning"].is_null(){"partial"}else{"completed"});}
        },
        Err(e)=>{let fault=fault(&e);let cancelled=fault["code"]=="cancelled";let has_result=!value["text"].as_str().unwrap_or("").trim().is_empty()||value["trace"].as_array().is_some_and(|r|!r.is_empty());
            value["status"]=json!(if cancelled{"cancelled"}else if has_result{"partial"}else{"failed"});value["fault"]=fault;
            if value["text"].as_str().unwrap_or("").trim().is_empty(){value["text"]=json!(format!("{}。{}。",e,if has_result{"已保留工具结果，可查看下方文件或仅整理已有结果"}else{"本次没有获得可用结果"}));}
        },
    }
    if let Some(items)=value["activities"].as_array_mut(){for a in items{if a["status"]=="running"{a["status"]=json!("interrupted");}}}
    if let Some(object)=value.as_object_mut(){object.remove("piRuntime");}
    if let Some(session)=value["taskContext"]["sessionId"].as_str(){if let Ok(mut current)=crate::assistant_context::load(state,session){if current.task_id==id{
        let status=value["status"].as_str().unwrap_or("failed");
        if current.status!=status{if let Err(error)=crate::assistant_context::finish(state,&mut current,status){value["warning"]=json!(error);}}
        value["taskContext"]=serde_json::to_value(current).unwrap();
    }}}
    value["finishedAt"]=json!(now());persist(state,id,&value);state.task_results.lock().unwrap().remove(id);value
}
