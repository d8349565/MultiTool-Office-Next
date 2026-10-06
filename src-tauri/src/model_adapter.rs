use crate::settings::Settings;
use serde_json::{json,Value};

#[derive(Clone,Copy)]
pub struct Capabilities { pub thinking_switch:bool, pub automatic_output:u32 }
pub fn capabilities(url:&str)->Capabilities{
    let thinking_switch=reqwest::Url::parse(url).ok().is_some_and(|u|u.host_str()==Some("api.deepseek.com"));
    Capabilities{thinking_switch,automatic_output:if thinking_switch{65536}else{8192}}
}
pub fn map_reasoning_effort(effort:&str)->Option<&'static str>{
    match effort.trim().to_ascii_lowercase().as_str(){"minimal"|"low"=>Some("low"),"medium"|"high"|"xhigh"=>Some("high"),"max"|"ultra"=>Some("max"),"none"=>Some("none"),_=>None}
}
pub fn with_reasoning(mut body:Value,effort:&str)->Value{if let Some(mapped)=map_reasoning_effort(effort){body["reasoning_effort"]=json!(mapped);}body}
pub fn output_tokens(url:&str,configured:u32)->u32{if configured>0{configured}else{capabilities(url).automatic_output}}
pub fn configured_body(url:&str,s:&Settings,body:Value,effort:&str,tokens:u32)->Value{
    let effort=effort.trim().to_ascii_lowercase();let cap=capabilities(url);let mut body=with_reasoning(body,&effort);
    if cap.thinking_switch{
        if effort=="none"{body.as_object_mut().unwrap().remove("reasoning_effort");body["thinking"]=json!({"type":"disabled"});}
        else if effort!="default"&&!effort.is_empty(){body["thinking"]=json!({"type":"enabled"});}
    }
    if tokens>0{body["max_tokens"]=json!(tokens);}
    if cap.thinking_switch&&effort!="none"{body.as_object_mut().unwrap().remove("temperature");}
    else if let Some(value)=s.model_temperature{body["temperature"]=json!(value);}
    if let Some(value)=s.model_top_p{body["top_p"]=json!(value);}
    body
}
