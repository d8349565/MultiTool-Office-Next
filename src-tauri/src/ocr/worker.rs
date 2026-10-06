use super::model::*;
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Write},path::Path,process::{Child,Command,Stdio},sync::{mpsc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};

pub struct Worker{child:Child,input:std::process::ChildStdin,rx:mpsc::Receiver<Result<Value,String>>,pending_preview:Option<String>}
impl Worker{
    fn preview_response(&mut self,cancel:&AtomicBool,started:Instant)->Result<Value,crate::file_preview::PreviewError>{
        use crate::file_preview::PreviewError::{Cancelled,Fatal};
        let id=self.pending_preview.as_ref().unwrap().clone();
        loop{
            if cancel.load(Ordering::Relaxed){return Err(Cancelled);}
            if started.elapsed()>Duration::from_secs(15){return Err(Fatal("预览加载超时，请用原程序打开".into()));}
            match self.rx.recv_timeout(Duration::from_millis(50)){
                Ok(Ok(value))=>{
                    self.pending_preview=None;
                    if value["id"]!=id||value["version"]!=1{return Err(Fatal("预览组件协议不匹配，请重新构建应用".into()));}
                    if !matches!(value["kind"].as_str(),Some("file_preview"|"error")){return Err(Fatal("预览组件需要更新，请重新构建应用".into()));}
                    return Ok(value);
                },
                Ok(Err(error))=>return Err(Fatal(error)),Err(mpsc::RecvTimeoutError::Timeout)=>{},Err(_)=>return Err(Fatal("本地预览组件意外退出".into())),
            }
        }
    }
    pub fn file_preview(&mut self,path:&str,page:u32,sheet:u32,cancel:&AtomicBool,started:Instant)->Result<Value,crate::file_preview::PreviewError>{
        use crate::file_preview::PreviewError::{Cancelled,File,Fatal};
        // 串行子进程只保留一份在途读取；取消后先收掉旧响应，不能把旧内容当成新文件。
        if self.pending_preview.is_some(){self.preview_response(cancel,started)?;}
        if cancel.load(Ordering::Relaxed){return Err(Cancelled);}
        let id=uuid::Uuid::new_v4().to_string();let body=crate::file_preview::request(path,page,sheet,&id);
        writeln!(self.input,"{body}").and_then(|_|self.input.flush()).map_err(|_|Fatal("无法加载本地预览组件".into()))?;
        self.pending_preview=Some(id);
        let value=self.preview_response(cancel,started)?;
        if value["kind"]=="error"{return Err(File(value["error"].as_str().unwrap_or("文件预览失败").to_owned()));}
        let preview=value["preview"].clone();
        if !matches!(preview["kind"].as_str(),Some("text"|"table"|"image")){return Err(Fatal("预览结果无效".into()));}
        if preview["kind"]=="image"&&!preview["image"].as_str().is_some_and(|image|image.starts_with("data:image/png;base64,")){return Err(Fatal("预览图片无效".into()));}
        Ok(preview)
    }
    pub fn preview(&mut self,path:&str,page:u32)->Result<Value,String>{
        let id=uuid::Uuid::new_v4().to_string();
        let body=json!({"version":1,"op":"preview","id":id,"path":path,"pages":page.to_string(),"dpi":100});
        writeln!(self.input,"{body}").and_then(|_|self.input.flush()).map_err(|e|e.to_string())?;
        let v=self.rx.recv_timeout(Duration::from_secs(60)).map_err(|_|"样本预览超时或引擎已退出")??;
        if v["id"]!=id||v["version"]!=1{return Err("样本预览协议校验失败".into());}
        if v["kind"]=="error"{return Err(v["error"].as_str().unwrap_or("样本预览失败").into());}
        if v["kind"]!="preview"||!v["image"].as_str().is_some_and(|s|s.starts_with("data:image/png;base64,")){return Err("样本预览数据无效，请重新构建 OCR 引擎".into());}
        Ok(v)
    }
    pub fn spawn(exe:&Path)->Result<Self,String>{
        let mut command=Command::new(exe);command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn().map_err(|e|format!("OCR 引擎启动失败：{e}"))?;
        let input=child.stdin.take().ok_or("OCR 输入管道不可用")?;let output=child.stdout.take().ok_or("OCR 输出管道不可用")?;
        let(tx,rx)=mpsc::channel();std::thread::spawn(move||{let mut reader=BufReader::new(output);loop{let mut data=Vec::new();let result=std::io::Read::take(&mut reader,8_000_001).read_until(b'\n',&mut data);match result{Ok(0)=>break,Ok(_)if data.len()>8_000_000=>{let _=tx.send(Err("OCR 单页输出过大".into()));break;},Ok(_)=>{if tx.send(serde_json::from_slice(&data).map_err(|_|"OCR 返回无效消息".into())).is_err(){break;}},Err(e)=>{let _=tx.send(Err(e.to_string()));break;}}}});
        Ok(Self{child,input,rx,pending_preview:None})
    }
    pub fn recognize(&mut self,file:&OcrFileResult,p:&OcrProfile,skip:&[u32],cancel:&AtomicBool,mut page:impl FnMut(Vec<OcrLine>)->Result<(),String>)->Result<(),String>{
        // 用户画框即物理沙箱：完整下发用户圈选的区域，驱动底层执行图像物理切片，彻底阻断框外数据外泄并提升性能
        let regions = p.regions.clone();
        let id=uuid::Uuid::new_v4().to_string();let body=json!({"version":1,"op":"recognize","id":id,"path":file.path,"pages":p.pages,"dpi":p.dpi,"skip":skip,"regions":regions});
        writeln!(self.input,"{body}").and_then(|_|self.input.flush()).map_err(|e|format!("OCR 输入管道错误：{e}"))?;
        let mut last=Instant::now();let started=Instant::now();
        loop{
            if cancel.load(Ordering::Relaxed){return Err("任务已取消".into());}
            if started.elapsed()>Duration::from_secs(900){return Err("OCR 单文件处理超过 15 分钟".into());}
            if last.elapsed()>Duration::from_secs(120){return Err("OCR 引擎超过 120 秒无响应".into());}
            match self.rx.recv_timeout(Duration::from_millis(100)){
                Ok(Ok(v))=>{if v["id"]!=id||v["version"]!=1{return Err("OCR 协议校验失败".into());}last=Instant::now();match v["kind"].as_str(){Some("done")=>return Ok(()),Some("error")=>return Err(v["error"].as_str().unwrap_or("OCR 失败").to_owned()),Some("page")=>{let lines:Vec<OcrLine>=serde_json::from_value(v["lines"].clone()).map_err(|_|"OCR 行数据无效")?;if lines.iter().any(|l|l.page==0||!l.score.is_finite()||!(0.0..=1.0).contains(&l.score)||l.text.len()>100_000){return Err("OCR 行数据超出范围".into());}page(lines)?;},Some("ready")=>{},_=>return Err("未知 OCR 事件".into())}},
                Ok(Err(e))=>return Err(e),Err(mpsc::RecvTimeoutError::Timeout)=>{},Err(_)=>return Err("OCR 引擎意外退出".into()),
            }
        }
    }
}
impl Drop for Worker{fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
