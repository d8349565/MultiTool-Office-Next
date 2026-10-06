use crate::{ocr::worker::Worker, AppState};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

#[derive(Default)]
pub struct Previews {
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    worker: Mutex<Option<Worker>>,
}

pub enum PreviewError { Cancelled, File(String), Fatal(String) }
impl PreviewError {
    pub fn requires_reset(&self)->bool{matches!(self,Self::Fatal(_))}
    pub fn message(self)->String{match self{Self::Cancelled=>"预览已取消".into(),Self::File(message)|Self::Fatal(message)=>message}}
}

fn validate(path:&Path,page:u32,sheet:u32)->Result<(),String>{
    if !(1..=10000).contains(&page)||sheet>=32{return Err("预览页码或工作表无效".into());}
    let extension=path.extension().and_then(|value|value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["pdf","png","jpg","jpeg","bmp","tif","tiff","webp","gif","txt","md","markdown","csv","tsv","json","xml","yaml","yml","log","ini","toml","rs","ts","tsx","js","jsx","css","html","htm","py","sql","docx","xlsx"].contains(&extension.as_str()){
        return Err("此格式暂不支持内容预览，请用原程序打开".into());
    }
    let metadata=std::fs::metadata(path).map_err(|_|"文件已移动、删除或无法读取")?;
    if !metadata.is_file()||metadata.len()>100*1024*1024{return Err("文件超过 100 MB 预览限制或不是普通文件，请用原程序打开".into());}
    Ok(())
}

#[tauri::command]
pub async fn file_preview(state:tauri::State<'_,Arc<AppState>>,path:String,request_id:String,page:u32,sheet:u32)->Result<Value,String>{
    if uuid::Uuid::parse_str(&request_id).is_err(){return Err("预览请求编号无效".into());}
    let path=state.index.authorize(&path)?;
    validate(&path,page,sheet)?;
    let state=state.inner().clone();
    let cancel={
        let mut requests=state.file_previews.requests.lock().unwrap();
        // 新预览终止旧任务，避免悬停连续移动时堆积后台读取。
        for flag in requests.values(){flag.store(true,Ordering::Relaxed);}
        if requests.len()>=16{return Err("正在取消上一份预览，请稍后重试".into());}
        let flag=Arc::new(AtomicBool::new(false));requests.insert(request_id.clone(),flag.clone());flag
    };
    tauri::async_runtime::spawn_blocking(move||{
        let result=(||{
            let started=Instant::now();
            loop{
                if cancel.load(Ordering::Relaxed){return Err("预览已取消".into());}
                if started.elapsed()>Duration::from_secs(15){return Err("预览加载超时，请用原程序打开".into());}
                if let Ok(mut slot)=state.file_previews.worker.try_lock(){
                    if cancel.load(Ordering::Relaxed){return Err("预览已取消".into());}
                    if slot.is_none(){*slot=Some(Worker::spawn(&state.ocr.exe)?);}
                    let result=slot.as_mut().unwrap().file_preview(&path.to_string_lossy(),page,sheet,&cancel,started);
                    if result.as_ref().err().is_some_and(PreviewError::requires_reset){*slot=None;}
                    return result.map_err(PreviewError::message);
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        })();
        state.file_previews.requests.lock().unwrap().remove(&request_id);
        result
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub fn cancel_file_preview(state:tauri::State<Arc<AppState>>,request_id:String){
    if let Some(cancel)=state.file_previews.requests.lock().unwrap().get(&request_id){cancel.store(true,Ordering::Relaxed);}
}

pub fn request(path:&str,page:u32,sheet:u32,id:&str)->Value{json!({"version":1,"op":"file_preview","id":id,"path":path,"page":page,"sheet":sheet})}
