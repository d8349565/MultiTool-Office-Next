use crate::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::sync::{mpsc, oneshot};

// PI 只请求调度步骤。模型、参数、范围与副作用始终由原生任务持有。
#[derive(Clone, Deserialize)]
#[serde(tag="type", rename_all="snake_case", deny_unknown_fields)]
pub enum Action {
    Model { round:u32 },
    Tool { round:u32, #[serde(rename="callId")] call_id:String, #[serde(default)] rejected:bool },
    Fail { message:String },
}
impl Action {
    fn key(&self)->String {match self{Self::Model{round}=>format!("model:{round}"),Self::Tool{round,call_id,..}=>format!("tool:{round}:{call_id}"),Self::Fail{..}=>"fail".into()}}
}
pub struct Link {
    sender:mpsc::Sender<Request>,
    completed:Mutex<HashMap<String,Value>>,
}
pub struct Request { pub action:Action, reply:Option<oneshot::Sender<Result<Value,String>>> }
impl Request {
    fn respond(&mut self,result:Result<Value,String>){if let Some(reply)=self.reply.take(){let _=reply.send(result);}}
}
impl Drop for Request {
    fn drop(&mut self){self.respond(Err("原生任务已停止，请查看任务记录".into()));}
}
pub struct Broker {link:Arc<Link>,receiver:mpsc::Receiver<Request>}
impl Broker {
    pub fn open(state:&AppState,id:&str)->Self{
        let (sender,receiver)=mpsc::channel(16);
        let link=Arc::new(Link{sender,completed:Mutex::new(HashMap::new())});
        state.pi_sessions.lock().unwrap().insert(id.into(),link.clone());
        Self{link,receiver}
    }
    pub fn publish(&self,app:&tauri::AppHandle,id:&str,round:u32,tools:&Value,model_id:&str,replay:Option<Value>){
        crate::task_state::emit(app,"pi-start",json!({"id":id,"round":round,"tools":tools,"modelId":model_id,"replay":replay}));
    }
    async fn wait(&mut self,expected:&str,cancel:&AtomicBool)->Result<Request,String>{
        loop {
            let mut request=tokio::select!{
                request=self.receiver.recv()=>request.ok_or("助手调度已断开")?,
                _=async {while !cancel.load(Ordering::Relaxed){tokio::time::sleep(Duration::from_millis(40)).await;}}=>return Err("任务已取消".into()),
            };
            let cached=self.link.completed.lock().unwrap().get(&request.action.key()).cloned();
            if let Some(cached)=cached{request.respond(Ok(cached));continue;}
            if let Action::Fail{message}=&request.action{return Err(format!("助手核心执行失败：{}",message.chars().take(300).collect::<String>()));}
            if request.action.key()!=expected{request.respond(Err("调度步骤与原生任务状态不一致".into()));continue;}
            return Ok(request);
        }
    }
    pub async fn model(&mut self,round:u32,cancel:&AtomicBool)->Result<Request,String>{self.wait(&format!("model:{round}"),cancel).await}
    pub async fn tool(&mut self,round:u32,id:&str,cancel:&AtomicBool)->Result<Request,String>{self.wait(&format!("tool:{round}:{id}"),cancel).await}
    pub fn complete(&self,mut request:Request,value:Value){
        self.link.completed.lock().unwrap().insert(request.action.key(),value.clone());
        request.respond(Ok(value));
    }
}
#[tauri::command]
pub async fn pi_step(state:tauri::State<'_,Arc<AppState>>,id:String,action:Action)->Result<Value,String>{
    if let Action::Tool{call_id,..}=&action{if call_id.len()>200{return Err("工具调用标识过长".into());}}
    let link=state.pi_sessions.lock().unwrap().get(&id).cloned().ok_or("任务已停止或不属于 PI 调度")?;
    if let Some(value)=link.completed.lock().unwrap().get(&action.key()).cloned(){return Ok(value);}
    let (reply,result)=oneshot::channel();
    link.sender.send(Request{action,reply:Some(reply)}).await.map_err(|_|"任务已停止")?;
    result.await.map_err(|_|"原生任务已停止，请查看任务记录")?
}
