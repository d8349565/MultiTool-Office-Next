use crate::settings::Settings;
use serde_json::{json,Value};

// 未识别的模型采用保守的发送预算，不将此值声称为模型的实际规格。
fn capacity(s:&Settings)->usize{
    if s.model_context_tokens>0{return s.model_context_tokens as usize;}
    let model=s.model_id.trim().to_ascii_lowercase();
    if ["deepseek-flash","deepseek-v4"].iter().any(|prefix|model.strip_prefix(*prefix).is_some_and(|rest|rest.is_empty()||rest.starts_with(['-','.','(']))){1_000_000}else{32_768}
}
fn estimate(value:&Value)->usize{
    match value{
        Value::String(text)=>{let ascii=text.chars().filter(char::is_ascii).count();ascii.div_ceil(3)+(text.chars().count()-ascii)*2+4},
        Value::Array(items)=>items.iter().map(estimate).sum::<usize>()+items.len()*4,
        Value::Object(object) if object.get("type").and_then(Value::as_str)==Some("image_url")=>4096,
        Value::Object(object)=>object.iter().map(|(key,value)|key.len()+estimate(value)).sum::<usize>()+8,
        _=>4,
    }
}
fn excerpt(text:&str,limit:usize)->String{
    if text.chars().count()<=limit{return text.into();}
    let head:String=text.chars().take(limit*2/3).collect();let tail:String=text.chars().rev().take(limit/3).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}\n（中间资料已压缩，完整内容保留在本地记录）\n{tail}")
}
pub fn compact(value:&mut Value,limit:usize){compact_inner(value,limit,true);}
fn compact_inner(value:&mut Value,limit:usize,annotate:bool){
    match value{
        Value::String(text)=>*text=excerpt(text,limit),
        Value::Array(items)=>{items.truncate(5);for item in items{compact_inner(item,limit,annotate);}},
        Value::Object(object)=>{
            for (key,value) in object.iter_mut(){
                // 交付地址、执行状态与错误必须完整保留，避免续接时重复生成或误报成功。
                if !["id","evidenceId","resultSetId","sourceRef","filename","path","parent","root","href","url","status","error","total"].contains(&key.as_str()){compact_inner(value,limit,annotate);}
            }
            if annotate{object.insert("_contextCompacted".into(),json!(true));}
        },
        _=>{},
    }
}
fn compact_messages(body:&mut Value,limit:usize)->Result<(),String>{
    let messages=body["messages"].as_array_mut().ok_or("模型消息格式无效")?;
    for message in messages{
        match message["role"].as_str(){
            Some("tool")=>{
                if let Some(text)=message["content"].as_str(){
                    let text=if let Ok(mut value)=serde_json::from_str::<Value>(text){compact(&mut value,limit);value.to_string()}else{excerpt(text,limit)};
                    message["content"]=json!(text);
                }
            },
            Some("assistant")=>{
                for key in ["content","reasoning_content","reasoning"]{if let Some(text)=message[key].as_str(){message[key]=json!(excerpt(text,limit));}}
                if let Some(calls)=message.get_mut("tool_calls").and_then(Value::as_array_mut){for call in calls{if let Some(args)=call["function"]["arguments"].as_str(){
                    if let Ok(mut value)=serde_json::from_str::<Value>(args){compact_inner(&mut value,limit,false);call["function"]["arguments"]=json!(value.to_string());}
                }}}
            },
            // 原始用户要求、原生目标和权限约束不做截断，也不改变工具调用配对。
            _=>{},
        }
    }
    Ok(())
}
fn drop_oldest_history_turn(body:&mut Value)->bool{
    // 仅使用原生组装时标记的历史边界；收尾、续写和校验提示同样是 user，不能据此猜测当前请求。
    let Some(end)=body["_historyEnd"].as_u64().map(|n|n as usize) else{return false;};
    let Some(messages)=body["messages"].as_array_mut() else{return false;};let end=end.min(messages.len());
    let Some(start)=(0..end).find(|&i|!matches!(messages[i]["role"].as_str(),Some("system"|"developer"))) else{return false;};
    let next=(start+1..end).find(|&i|matches!(messages[i]["role"].as_str(),Some("user"|"system"|"developer"))).unwrap_or(end);
    // 一次删除旧用户消息及其全部回复/工具结果，不留下孤立的 tool 消息。
    messages.drain(start..next);body["_historyEnd"]=json!(end-(next-start));true
}
pub fn prepare(s:&Settings,body:&mut Value,force:bool)->Result<bool,String>{
    let capacity=capacity(s);let margin=(capacity/10).max(512);
    let requested=body["max_tokens"].as_u64().or_else(||body["max_completion_tokens"].as_u64()).unwrap_or(8192) as usize;
    let budget=capacity.saturating_sub(margin+requested.min(capacity/2));
    let before=estimate(body);
    if force||before>budget*4/5{compact_messages(body,if force{256}else{1200})?;}
    // 服务端的真实分词或容量可能小于本地估算；重试必须实际缩小请求。
    let target=if force{budget.min(before*3/4)}else{budget};
    while estimate(body)>target&&drop_oldest_history_turn(body){}
    if !force&&estimate(body)>budget{compact_messages(body,256)?;}
    let mut changed=estimate(body)<before;
    let available=capacity.saturating_sub(estimate(body)+margin);
    if available<256{return Err("模型上下文容量不足，自动压缩后仍无法容纳本轮要求。完整资料已保留，请缩短本轮输入、减少历史条数，或在模型参数中核对实际上下文容量后继续。".into());}
    let output=if force{requested.min(available).min((requested/2).max(256))}else{requested.min(available)};
    if output<requested{
        let key=if body.get("max_completion_tokens").is_some(){"max_completion_tokens"}else{"max_tokens"};
        body[key]=json!(output);changed=true;
    }
    Ok(changed)
}
pub fn is_context_error(message:&str)->bool{
    let text=message.to_ascii_lowercase();
    ["context_length","context window","context length","maximum context","max_context","too many tokens","prompt is too long","input is too long","上下文"].iter().any(|key|text.contains(key))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn compaction_keeps_requirements_identifiers_and_tool_pairs(){
        let settings=Settings{model_context_tokens:16000,..Default::default()};
        let requirement="保留这个原始用户要求：仅新建，不覆盖，不改变授权目录。";
        let mut body=json!({"max_tokens":8192,"messages":[{"role":"system","content":"固定权限约束"},{"role":"user","content":requirement},{"role":"assistant","content":"x".repeat(80_000),"tool_calls":[{"id":"call-audit","function":{"name":"document_create","arguments":json!({"filename":"audit.txt","paragraphs":["x".repeat(10_000)]}).to_string()}}]},{"role":"tool","tool_call_id":"call-audit","content":json!({"id":"file-audit","filename":"audit.txt","href":"office-report:file-audit","status":"created","text":"y".repeat(20_000)}).to_string()}]});
        assert!(prepare(&settings,&mut body,false).unwrap());
        assert_eq!(body["messages"][1]["content"],requirement);assert_eq!(body["messages"][2]["tool_calls"][0]["id"],body["messages"][3]["tool_call_id"]);
        let output:Value=serde_json::from_str(body["messages"][3]["content"].as_str().unwrap()).unwrap();
        assert_eq!(output["href"],"office-report:file-audit");assert_eq!(output["status"],"created");
        let args:Value=serde_json::from_str(body["messages"][2]["tool_calls"][0]["function"]["arguments"].as_str().unwrap()).unwrap();assert!(args.get("_contextCompacted").is_none());
    }
    #[test]
    fn oversized_user_input_fails_without_silently_truncating_it(){
        let settings=Settings{model_context_tokens:1024,..Default::default()};let requirement="原始用户约束".repeat(2000);
        let mut body=json!({"max_tokens":256,"messages":[{"role":"user","content":requirement}]});
        assert!(prepare(&settings,&mut body,true).is_err());assert_eq!(body["messages"][0]["content"],requirement);
    }
    #[test]
    fn overflowing_history_is_removed_in_turns_without_losing_current_context(){
        let settings=Settings{model_context_tokens:6000,..Default::default()};
        let mut body=json!({"max_tokens":2048,"_historyEnd":5,"messages":[
            {"role":"system","content":"固定权限约束"},
            {"role":"user","content":"历史资料".repeat(3000)},{"role":"assistant","content":"旧回答一"},
            {"role":"user","content":"历史要求".repeat(3000)},{"role":"assistant","content":"旧回答二"},
            {"role":"user","content":"本轮原生权限范围"},{"role":"assistant","content":"当前证据来源"},
            {"role":"user","content":"当前真实要求"},
            {"role":"assistant","tool_calls":[{"id":"current-call","function":{"name":"files_query","arguments":"{}"}}]},
            {"role":"tool","tool_call_id":"current-call","content":"已有结果"},
            {"role":"user","content":"仅整理已有结果，不再调用工具"}
        ]});
        let original=body.clone();
        assert!(prepare(&settings,&mut body,false).unwrap());
        assert_eq!(body["_historyEnd"],1);
        assert_eq!(body["messages"][0],original["messages"][0]);
        assert_eq!(body["messages"].as_array().unwrap()[1..],original["messages"].as_array().unwrap()[5..]);
        assert!(estimate(&body)+body["max_tokens"].as_u64().unwrap() as usize+600<=6000);
    }
    #[test]
    fn forced_retry_reduces_output_budget_even_without_history(){
        let settings=Settings{model_context_tokens:32768,..Default::default()};
        let mut body=json!({"max_completion_tokens":8192,"messages":[{"role":"system","content":"固定权限约束"},{"role":"user","content":"当前要求"}]});
        let messages=body["messages"].clone();
        assert!(!prepare(&settings,&mut body,false).unwrap());
        assert!(prepare(&settings,&mut body,true).unwrap());
        assert_eq!(body["messages"],messages);assert_eq!(body["max_completion_tokens"],4096);assert!(body.get("max_tokens").is_none());
    }
    #[test]
    fn forced_retry_drops_only_marked_history_when_local_estimate_fits(){
        let settings=Settings{model_context_tokens:32768,..Default::default()};
        let mut body=json!({"max_tokens":512,"_historyEnd":3,"messages":[
            {"role":"system","content":"权限约束"},{"role":"user","content":[{"type":"text","text":"旧图片"},{"type":"image_url","image_url":{"url":"data:image/png;base64,old-image"}}]},{"role":"assistant","content":"旧答案"},
            {"role":"user","content":"本轮原生范围"},{"role":"user","content":"原始要求"},{"role":"assistant","content":"未完成回答"},{"role":"user","content":"继续回答"}
        ]});
        let current=body["messages"].as_array().unwrap()[3..].to_vec();
        assert!(prepare(&settings,&mut body,true).unwrap());
        assert_eq!(body["_historyEnd"],1);assert_eq!(body["messages"].as_array().unwrap()[1..],current);
    }
}
