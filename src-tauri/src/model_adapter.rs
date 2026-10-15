use crate::settings::Settings;
use serde_json::{json,Value};

#[derive(Clone,Copy)]
pub struct Capabilities { pub thinking_switch:bool, pub automatic_output:u32 }
pub fn capabilities(url:&str)->Capabilities{
    let thinking_switch=reqwest::Url::parse(url).ok().is_some_and(|u|u.host_str()==Some("api.deepseek.com"));
    Capabilities{thinking_switch,automatic_output:if thinking_switch||is_minimax(url,""){65536}else{8192}}
}
pub fn is_minimax(url:&str,model:&str)->bool{
    model.to_ascii_lowercase().starts_with("minimax-") || reqwest::Url::parse(url).ok().is_some_and(|u|matches!(u.host_str(),Some("api.minimax.cn"|"api.minimax.io"|"api.minimax.chat")))
}
pub fn endpoint(raw:&str)->Result<String,String>{
    let mut url=reqwest::Url::parse(raw.trim()).map_err(|_|"模型地址无效，请填写 API 服务地址")?;
    if url.host_str().is_none() || (url.scheme()!="https" && !(url.scheme()=="http" && matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]")))) {return Err("远程模型地址必须使用 HTTPS".into());}
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some(){return Err("地址不得包含凭据、查询参数或片段".into());}
    if url.host_str().is_some_and(|host|host.starts_with("platform.")) || url.path().contains("/docs") {return Err("请填写 API 服务地址，不是文档或控制台地址；MiniMax 使用 https://api.minimax.cn/v1".into());}
    let path=url.path().trim_end_matches('/');
    if path.ends_with("/messages") || path.ends_with("/responses"){return Err("请使用 OpenAI 兼容的 /v1/chat/completions 接口".into());}
    let path=if path.ends_with("/chat/completions"){path.to_owned()}else if path.is_empty(){if url.host_str()==Some("api.deepseek.com"){"/chat/completions".into()}else{"/v1/chat/completions".into()}}else{format!("{path}/chat/completions")};
    url.set_path(&path);Ok(url.to_string())
}
pub fn map_reasoning_effort(effort:&str)->Option<&'static str>{
    match effort.trim().to_ascii_lowercase().as_str(){"minimal"|"low"=>Some("low"),"medium"|"high"|"xhigh"=>Some("high"),"max"|"ultra"=>Some("max"),"none"=>Some("none"),_=>None}
}
pub fn with_reasoning(mut body:Value,effort:&str)->Value{if let Some(mapped)=map_reasoning_effort(effort){body["reasoning_effort"]=json!(mapped);}body}
pub fn output_tokens(url:&str,model:&str,configured:u32)->u32{if configured>0{configured}else if is_minimax(url,model){65536}else{capabilities(url).automatic_output}}
pub fn set_output_tokens(url:&str,model:&str,body:&mut Value,tokens:u32){
    body.as_object_mut().unwrap().remove("max_tokens");body.as_object_mut().unwrap().remove("max_completion_tokens");
    if tokens>0{body[if is_minimax(url,model){"max_completion_tokens"}else{"max_tokens"}]=json!(tokens);}
}
pub fn configured_body(url:&str,s:&Settings,body:Value,effort:&str,tokens:u32)->Value{
    let effort=effort.trim().to_ascii_lowercase();let cap=capabilities(url);let minimax=is_minimax(url,&s.model_id);let mut body=body;
    if minimax {
        body["reasoning_split"]=json!(true);
        // MiniMax M2/M3 的思考能力不同；不要发送不受支持的 none。
        if s.model_id.to_ascii_lowercase().starts_with("minimax-m3.1") {
            let mapped=match effort.as_str(){"minimal"=>"low","ultra"=>"max",other=>other};
            if ["low","medium","high","xhigh","max"].contains(&mapped){body["reasoning_effort"]=json!(mapped);}
        }
    }else if cap.thinking_switch {
        body=with_reasoning(body,&effort);
    }
    if cap.thinking_switch{
        if effort=="none"{body.as_object_mut().unwrap().remove("reasoning_effort");body["thinking"]=json!({"type":"disabled"});}
        else if effort!="default"&&!effort.is_empty(){body["thinking"]=json!({"type":"enabled"});}
    }
    let tokens=if tokens>0{tokens}else{body["max_tokens"].as_u64().or_else(||body["max_completion_tokens"].as_u64()).unwrap_or(0) as u32};
    set_output_tokens(url,&s.model_id,&mut body,tokens);
    if cap.thinking_switch&&effort!="none"{body.as_object_mut().unwrap().remove("temperature");}
    else if let Some(value)=s.model_temperature{body["temperature"]=json!(value);}
    if let Some(value)=s.model_top_p{body["top_p"]=json!(value);}
    if let Some(messages)=body["messages"].as_array_mut(){for message in messages{if let Some(object)=message.as_object_mut(){
        for key in ["reasoning_content","reasoning","tool_calls"]{if object.get(key).is_some_and(Value::is_null) || (key!="tool_calls"&&!minimax&&!cap.thinking_switch){object.remove(key);}}
    }}}
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimax_parameters_and_service_addresses(){
        let s=Settings{model_id:"MiniMax-M3.1-Flash-Preview".into(),..Settings::default()};
        let body=configured_body("https://api.minimax.cn/v1/chat/completions",&s,json!({"max_tokens":2048}),"none",0);
        assert!(body.get("reasoning_effort").is_none());assert!(body.get("max_tokens").is_none());assert_eq!(body["max_completion_tokens"],2048);
        let body=configured_body("https://api.minimax.cn/v1/chat/completions",&s,json!({}),"medium",8192);
        assert_eq!(body["reasoning_effort"],"medium");
        assert_eq!(endpoint("https://api.minimax.cn").unwrap(),"https://api.minimax.cn/v1/chat/completions");
        assert_eq!(endpoint("https://api.minimax.cn/v1/chat/completions/").unwrap(),"https://api.minimax.cn/v1/chat/completions");
        assert!(endpoint("https://platform.minimax.cn/docs/api-reference/text-chat-openai").is_err());
    }
}
