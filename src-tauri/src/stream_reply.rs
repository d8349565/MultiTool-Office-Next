use serde_json::{json, Value};
use std::{collections::BTreeMap,time::Instant};

#[derive(Default)]
pub struct StreamReply {
    text:String,
    reasoning:String,
    calls:BTreeMap<u64,Value>,
    model:Value,
    usage:Value,
    complete:bool,
    finish_reason:Option<String>,
    first_output:Option<Instant>,
    last_output:Option<Instant>,
}
impl StreamReply {
    pub fn output_size(&self)->usize{self.text.len()+self.reasoning.len()+self.calls.values().map(|v|v.to_string().len()).sum::<usize>()}
    pub fn line(&mut self,line:&[u8],on_text:Option<&(dyn Fn(&str)+Sync)>,on_reasoning:Option<&(dyn Fn(&str)+Sync)>)->Result<(),String>{
        let line=std::str::from_utf8(line).map_err(|_|"流式回复编码无效")?.trim();
        let Some(data)=line.strip_prefix("data:").map(str::trim) else{return Ok(())};
        if data=="[DONE]"{self.complete=true;return Ok(())}
        let v:Value=serde_json::from_str(data).map_err(|_|"流式回复格式无效")?;
        if !v["error"].is_null(){return Err("模型流式回复返回错误".into());}
        if !v["model"].is_null(){self.model=v["model"].clone();}
        if !v["usage"].is_null(){self.usage=v["usage"].clone();}
        let Some(choice)=v["choices"].as_array().and_then(|c|c.iter().find(|c|c["index"].as_u64().unwrap_or(0)==0)) else{return Ok(())};
        if let Some(reason)=choice["finish_reason"].as_str(){
            if !matches!(reason,"stop"|"tool_calls"|"length"){return Err(format!("模型回复未完成：{reason}"));}
            self.finish_reason=Some(reason.into());
            self.complete=true;
        }
        let delta=&choice["delta"];
        let has_output=["content","reasoning_content","reasoning"].iter().any(|key|delta[*key].as_str().is_some_and(|s|!s.is_empty())) || delta["tool_calls"].as_array().is_some_and(|calls|calls.iter().any(|call|["/id","/function/name","/function/arguments"].iter().any(|path|call.pointer(path).and_then(Value::as_str).is_some_and(|s|!s.is_empty()))));
        if has_output{let now=Instant::now();self.first_output.get_or_insert(now);self.last_output=Some(now);}
        if !choice["finish_reason"].is_null() && self.first_output.is_some(){self.last_output=Some(Instant::now());}
        if let Some(text)=delta["reasoning_content"].as_str().or_else(||delta["reasoning"].as_str()){self.reasoning.push_str(text);if let Some(emit)=on_reasoning{emit(&self.reasoning);}}
        if let Some(text)=delta["content"].as_str(){self.text.push_str(text);if let Some(emit)=on_text{emit(&self.text);}}
        if let Some(calls)=delta["tool_calls"].as_array(){for call in calls{
            let index=call["index"].as_u64().ok_or("工具片段缺少序号")?;
            if index>=32{return Err("模型工具调用过多".into());}
            let target=self.calls.entry(index).or_insert_with(||json!({"id":"","type":"function","function":{"name":"","arguments":""}}));
            for path in ["/id","/function/name","/function/arguments"]{
                if let Some(part)=call.pointer(path).and_then(Value::as_str){let value=target.pointer_mut(path).unwrap();*value=json!(format!("{}{part}",value.as_str().unwrap_or("")));}
            }
        }}
        Ok(())
    }
    pub fn finish(self)->Result<Value,String>{
        if !self.complete{return Err("模型流式连接提前结束，请重试".into());}
        let generation_ms=self.first_output.zip(self.last_output).map(|(first,last)|last.duration_since(first).as_secs_f64()*1000.0).filter(|ms|*ms>=1.0);
        let mut message=json!({"role":"assistant","content":self.text,"reasoning_content":self.reasoning});
        if !self.calls.is_empty(){message["tool_calls"]=json!(self.calls.into_values().collect::<Vec<_>>());}
        Ok(json!({"choices":[{"message":message,"finish_reason":self.finish_reason}],"model":self.model,"usage":self.usage,"generationMs":generation_ms}))
    }
}
