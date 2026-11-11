use crate::AppState;
use serde_json::{json, Value};
use rusqlite::OptionalExtension;
use std::collections::HashMap;
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
    let (code,recovery)=if message.contains("取消"){("cancelled","需要继续时可重试此任务")}
        else if message.contains("应用已关闭"){("interrupted","可继续未完成的任务，已完成的操作会保留")}
        else if ["HTTP 401","HTTP 403","模型密钥","尚未保存密钥","密钥无效","API Key"].iter().any(|key|message.contains(key)){("authentication","在设置页核对密钥和模型权限后重试")}
        else if crate::model_context::is_context_error(message){("context_limit","自动压缩后仍超出容量，请缩短输入、减少历史，或核对模型上下文容量；已有资料和文件链接保留")}
        else if message.contains("输出达到长度上限"){("output_limit","已有内容保留；可继续任务，或调整输出上限与思考程度")}
        else if ["轮次预算","操作预算"].iter().any(|key|message.contains(key)){("task_limit","已有结果保留；可继续未完成任务，或调整任务模型轮数")}
        else if message.contains("PDF")&&message.contains("排版"){("pdf_render","减少文档内容后重试；若排版组件不可用，请检查 WebView2 运行时")}
        else if message.contains("首响应"){("first_response_timeout","检查服务状态，或调整首响应等待后继续任务")}
        else if message.contains("停滞"){("output_stalled","检查网络后继续任务，已有结果保留")}
        else if ["超时","等待超过","时间上限","总预算","时间预算"].iter().any(|key|message.contains(key)){("timeout","调整等待预算后继续任务，已有结果保留")}
        else if message.contains("提前结束"){("stream_closed","检查连接后继续任务，已有内容保留")}
        else if message.contains("连接")||message.contains("读取模型"){("connection","检查网络，或重试未完成的请求")}
        else if message.contains("限流")||message.contains("繁忙"){("rate_limit","稍后重试")}

        else if message.contains("400")||message.contains("422"){("unsupported_parameters","检查模型能力与参数，不能悄悄降低思考程度")}
        else{("request_failed","查看错误原因后重试，已完成操作不会自动重放")};
    json!({"code":code,"message":message,"recovery":recovery})
}
fn write_record(db:&rusqlite::Connection,id:&str,value:&Value)->Result<(),String>{
    db.execute("INSERT OR REPLACE INTO assistant_tasks(id,data) VALUES(?1,?2)",rusqlite::params![id,value.to_string()]).map_err(|_|"任务记录保存失败，请检查磁盘空间和文件权限".to_owned())?;Ok(())
}
fn persist(state:&AppState,id:&str,value:&Value)->Result<(),String>{write_record(&state.index.db.lock().unwrap(),id,value)}
fn save_finished(db:&rusqlite::Connection,cache:&mut HashMap<String,Value>,id:&str,mut value:Value)->Value{
    if let Some(object)=value.as_object_mut(){object.remove("storageWarning");}
    match write_record(db,id,&value){
        Ok(())=>{cache.remove(id);},
        Err(error)=>{value["storageWarning"]=json!(format!("{error}。完整结果暂保留在本次运行内，请勿退出应用；处理存储问题后可重试保存结果。"));cache.insert(id.into(),value.clone());},
    }value
}
pub fn start(state:&AppState,id:&str,route:&str,session:&str,context:&Value)->Result<(),String>{
    let latest=crate::assistant_context::load(state,session)?;
    let current=crate::assistant_context::action_context(state,&latest,context)?;
    let value=json!({"id":id,"sessionId":session,"taskContext":current,"status":"running","route":route,"startedAt":now(),"deadlineAt":now()+state.settings.lock().unwrap().assistant_task_timeout_secs*1000,"checkpointAt":now(),"activities":[],"trace":[],"usage":[],"text":"","progress":"正在准备任务"});
    persist(state,id,&value)?;state.task_results.lock().unwrap().insert(id.into(),value);Ok(())
}
pub fn get(state:&AppState,id:&str)->Result<Value,String>{
    let mut cache=state.task_results.lock().unwrap();
    if let Some(value)=cache.get(id).cloned(){
        if value["status"]!="running"&&value["storageWarning"].is_string(){return Ok(save_finished(&state.index.db.lock().unwrap(),&mut cache,id,value));}
        return Ok(value);
    }
    drop(cache);
    let raw:Option<String>=state.index.db.lock().unwrap().query_row("SELECT data FROM assistant_tasks WHERE id=?1",[id],|r|r.get(0)).optional().map_err(|_|"任务记录暂时无法读取，请检查存储状态后重试")?;
    let raw=raw.ok_or("任务记录不存在")?;
    serde_json::from_str(&raw).map_err(|_|"任务记录无法读取".into())
}
// 按次服务独立记账；发送前和完成后都立即落盘，不受模型用量事件覆盖。
pub fn service_usage(state:&AppState,app:&tauri::AppHandle,id:&str,record:&Value)->Result<(),String>{
    let mut snapshots=state.task_results.lock().unwrap();
    let task=snapshots.get_mut(id).ok_or("任务已停止，未继续发送收费请求")?;
    if !task["serviceUsage"].is_array(){task["serviceUsage"]=json!([]);}
    let records=task["serviceUsage"].as_array_mut().unwrap();
    if let Some(old)=records.iter_mut().find(|r|r["id"]==record["id"]){*old=record.clone();}else{records.push(record.clone());}
    state.index.db.lock().unwrap().execute("INSERT OR REPLACE INTO assistant_tasks(id,data) VALUES(?1,?2)",rusqlite::params![id,task.to_string()]).map_err(|_|"费用记录保存失败，已停止后续收费请求")?;
    let payload=json!({"id":id,"serviceUsage":task["serviceUsage"]});drop(snapshots);
    let _=app.emit("task-service-usage",payload);Ok(())
}
pub fn emit(app:&tauri::AppHandle,event:&str,payload:Value){
    let mut storage_notice=None;
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
            if matches!(event,"task-context"|"pi-start")||now().saturating_sub(s["checkpointAt"].as_u64().unwrap_or(0))>=1000 || event=="task-activity"&&payload["activity"]["status"]!="running"{
                s["checkpointAt"]=json!(now());let previous=s.as_object_mut().unwrap().remove("storageWarning");
                match persist(&state,id,s){
                    Ok(())=>{if previous.is_some(){storage_notice=Some(json!({"id":id,"message":""}));}},
                    Err(error)=>{let message=format!("{error}，当前进度暂保留在本次运行内，请勿退出应用。");s["storageWarning"]=json!(message);if previous.is_none(){storage_notice=Some(json!({"id":id,"message":message}));}},
                }
            }
        }
    }}
    if let Some(notice)=storage_notice{let _=app.emit("task-storage-warning",notice);}
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
            if value["text"].as_str().unwrap_or("").trim().is_empty(){value["text"]=json!(format!("{}。{}。",e,if has_result{"已保留工具结果，可查看下方文件或继续任务"}else{"本次没有获得可用结果"}));}
        },
    }
    if let Some(items)=value["activities"].as_array_mut(){for a in items{if a["status"]=="running"{a["status"]=json!("interrupted");}}}
    if let Some(object)=value.as_object_mut(){object.remove("piRuntime");}
    if let Some(session)=value["taskContext"]["sessionId"].as_str(){if let Ok(mut current)=crate::assistant_context::load(state,session){if current.task_id==id{
        let status=value["status"].as_str().unwrap_or("failed");
        if current.status!=status{if let Err(error)=crate::assistant_context::finish(state,&mut current,status){value["warning"]=json!(error);}}
        value["taskContext"]=serde_json::to_value(current).unwrap();
    }}}
    value["finishedAt"]=json!(now());let mut cache=state.task_results.lock().unwrap();save_finished(&state.index.db.lock().unwrap(),&mut cache,id,value)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn failed_final_save_keeps_the_result_and_can_be_retried(){
        let db=rusqlite::Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE assistant_tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL)").unwrap();
        write_record(&db,"task",&json!({"status":"running"})).unwrap();db.execute_batch("PRAGMA query_only=ON").unwrap();
        let mut cache=HashMap::new();let result=json!({"id":"task","status":"completed","text":"完整结果","trace":[{"tool":"document_create","result":{"id":"saved-file","status":"created"}}]});
        let pending=save_finished(&db,&mut cache,"task",result.clone());
        assert_eq!(pending["status"],"completed");assert!(pending["storageWarning"].is_string());assert_eq!(cache["task"]["text"],result["text"]);assert_eq!(cache["task"]["trace"],result["trace"]);
        db.execute_batch("PRAGMA query_only=OFF").unwrap();let saved=save_finished(&db,&mut cache,"task",pending);
        assert!(cache.is_empty());assert!(saved.get("storageWarning").is_none());
        let raw:String=db.query_row("SELECT data FROM assistant_tasks WHERE id='task'",[],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(),result);
    }
    #[test]
    fn recovery_advice_distinguishes_service_errors_from_file_protection(){
        assert_eq!(fault("模型服务返回 HTTP 401：密钥无效")["code"],"authentication");
        assert_eq!(fault("此模型配置尚未保存密钥，请在设置中填写并测试")["code"],"authentication");
        assert_eq!(fault("模型服务返回错误 E_AUDIT，request_id=a401b403")["code"],"request_failed");
        assert_eq!(fault("文件内容含疑似密钥、密码或私钥，已阻止发送给模型")["code"],"request_failed");
        assert_eq!(fault("无法核对文件修改时间，请保存文件后重试")["code"],"request_failed");
        assert_eq!(fault("本轮模型请求达到可用时间上限")["code"],"timeout");
        assert_eq!(fault("已达到任务时间预算")["code"],"timeout");
        assert_eq!(fault("模型输出达到长度上限")["code"],"output_limit");
        assert_eq!(fault("工具轮次预算已用尽")["code"],"task_limit");
    }
}
