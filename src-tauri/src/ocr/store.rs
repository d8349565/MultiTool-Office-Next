use super::{model::*,rules};
use rusqlite::{Connection,params};
use serde::{Serialize,Deserialize};
use std::{collections::{BTreeMap,HashMap,HashSet,VecDeque},io::{Read,Write},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::AtomicBool}};
use sha2::{Digest,Sha256};

pub struct Data {pub profiles:Vec<OcrProfile>,pub tasks:BTreeMap<String,OcrTask>,pub batches:BTreeMap<String,OcrRenameBatch>,pub grants:HashSet<String>,pub queue:VecDeque<String>,pub running:bool}
pub struct OcrStore {pub dir:PathBuf,pub exe:PathBuf,pub data:Mutex<Data>,pub cancels:Mutex<HashMap<String,Arc<AtomicBool>>>,pub proposals:super::assistant::Proposals,db:Mutex<Connection>,pub unavailable_reason:Option<String>}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct StoredTask {id:String,created:u64,status:String,#[serde(default)]concurrency:usize,#[serde(default)]batch_elapsed_ms:Option<u64>,profiles:Vec<OcrProfile>,file_ids:Vec<String>,#[serde(default)]auto_match:bool,#[serde(default)]workflow:OcrWorkflow,#[serde(default)]cleared_file_ids:Vec<String>}
impl StoredTask {
    fn from_task(t:&OcrTask)->Self{Self{id:t.id.clone(),created:t.created,status:t.status.clone(),concurrency:t.concurrency,batch_elapsed_ms:t.batch_elapsed_ms,profiles:t.profiles.clone(),file_ids:t.files.iter().map(|f|f.id.clone()).collect(),auto_match:t.auto_match,workflow:t.workflow.clone(),cleared_file_ids:t.cleared_file_ids.clone()}}
}
fn file_path(dir:&Path,task_id:&str,file_id:&str)->PathBuf{dir.join(format!("task-{task_id}-{file_id}.json"))}
fn stored_file(f:&OcrFileResult)->OcrFileResult{
    let mut saved=f.clone();
    if let Some(diag)=&mut saved.diagnostics{
        if let Some(timings)=&mut diag.timings{timings.save_ms=None;}
    }
    for line in &mut saved.lines {
        line.text = rules::mask(&line.text); // 本地落盘敏感数据原位脱敏
    }
    saved
}
pub fn atomic_json(path:&Path,value:&impl Serialize)->Result<(),String>{let mut f=tempfile::NamedTempFile::new_in(path.parent().ok_or("无父目录")?).map_err(|e|e.to_string())?;serde_json::to_writer(&mut f,value).map_err(|e|e.to_string())?;f.flush().and_then(|_|f.as_file().sync_all()).map_err(|e|e.to_string())?;f.persist(path).map_err(|e|e.to_string())?;Ok(())}
impl OcrStore{
    pub fn disabled(dir:&Path,exe:PathBuf,reason:String)->Result<Self,String>{
        Ok(Self{dir:dir.join("workspace").join("ocr"),exe,data:Mutex::new(Data{profiles:defaults(),tasks:BTreeMap::new(),batches:BTreeMap::new(),grants:HashSet::new(),queue:VecDeque::new(),running:false}),cancels:Mutex::new(HashMap::new()),proposals:Default::default(),db:Mutex::new(Connection::open_in_memory().map_err(|e|e.to_string())?),unavailable_reason:Some(reason)})
    }
    pub fn ensure_available(&self)->Result<(),String>{if let Some(reason)=&self.unavailable_reason{Err(format!("OCR 暂不可用：{reason}"))}else{Ok(())}}
    pub fn open(dir:&Path,exe:PathBuf)->Result<Self,String>{
        let ocr=dir.join("workspace").join("ocr");std::fs::create_dir_all(&ocr).map_err(|e|e.to_string())?;
        let profile_path=ocr.join("profiles.json");let previous_path=ocr.join("profiles.previous.json");
        let read_profiles=|path:&Path|->Result<Vec<OcrProfile>,String>{
            let profiles:Vec<OcrProfile>=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            for p in &profiles{rules::validate(p)?;}Ok(profiles)
        };
        let profiles=if profile_path.exists(){match read_profiles(&profile_path){
            Ok(p)=>p,
            Err(e)=>{eprintln!("OCR 配置损坏，尝试恢复：{e}");let corrupt=ocr.join(format!("profiles.corrupt-{}.json",uuid::Uuid::new_v4()));let _=std::fs::rename(&profile_path,&corrupt);let p=read_profiles(&previous_path).unwrap_or_else(|_|defaults());atomic_json(&profile_path,&p)?;p}
        }}else{let p=read_profiles(&previous_path).unwrap_or_else(|_|defaults());atomic_json(&profile_path,&p)?;p};
        let db=Connection::open(dir.join("office.sqlite")).map_err(|e|e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ocr_tasks(id TEXT PRIMARY KEY,created INTEGER,status TEXT,file_count INTEGER); CREATE TABLE IF NOT EXISTS ocr_renames(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ocr_rename_updates(batch_id TEXT NOT NULL, item_index INTEGER NOT NULL, phase TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(batch_id,item_index));").map_err(|e|e.to_string())?;
        let mut tasks=BTreeMap::new();let mut grants=HashSet::new();let mut recovered_tasks=vec![];
        for entry in std::fs::read_dir(&ocr).map_err(|e|e.to_string())?.filter_map(Result::ok){let name=entry.file_name().to_string_lossy().into_owned();if name.strip_prefix("task-").and_then(|v|v.strip_suffix(".json")).is_some_and(|id|uuid::Uuid::parse_str(id).is_ok()){
            if let Ok(bytes)=std::fs::read(entry.path()){
                let loaded:Result<OcrTask,serde_json::Error>=serde_json::from_slice::<OcrTask>(&bytes).or_else(|_|{
                    let header:StoredTask=serde_json::from_slice(&bytes)?;
                    uuid::Uuid::parse_str(&header.id).map_err(|e|serde::de::Error::custom(e.to_string()))?;
                    let files=header.file_ids.iter().map(|id|{
                        uuid::Uuid::parse_str(id).map_err(|e|serde::de::Error::custom(e.to_string()))?;
                        let data=std::fs::read(file_path(&ocr,&header.id,id)).map_err(|e|serde::de::Error::custom(e.to_string()))?;
                        serde_json::from_slice::<OcrFileResult>(&data)
                    }).collect::<Result<Vec<_>,serde_json::Error>>()?;
                    Ok(OcrTask{id:header.id,created:header.created,status:header.status,concurrency:header.concurrency,batch_elapsed_ms:header.batch_elapsed_ms,profiles:header.profiles,files,auto_match:header.auto_match,workflow:header.workflow,cleared_file_ids:header.cleared_file_ids})
                });
                if let Ok(mut t)=loaded{if ["queued","running"].contains(&t.status.as_str()){t.status="interrupted".into();t.batch_elapsed_ms=None;if t.workflow.enabled{t.workflow.status="interrupted".into();}let mut files=vec![];for (index,f) in t.files.iter_mut().enumerate(){if ["queued","running"].contains(&f.status.as_str()){f.status="interrupted".into();f.error="应用已退出，可重试未完成项".into();files.push(index);}}recovered_tasks.push((t.id.clone(),files));}for f in &t.files{if f.status!="relocated"{grants.insert(f.path.clone());}}tasks.insert(t.id.clone(),t);}
            }
        }}
        let mut batches=BTreeMap::new();let mut recovered_batches=vec![];{
            let mut stmt=db.prepare("SELECT data FROM ocr_renames").map_err(|e|e.to_string())?;let rows=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
            for row in rows{let raw=row.map_err(|e|e.to_string())?;let mut b:OcrRenameBatch=serde_json::from_str(&raw).map_err(|e|e.to_string())?;let mut recovered=false;
                let mut updates=db.prepare("SELECT item_index,phase,item FROM ocr_rename_updates WHERE batch_id=?1 ORDER BY item_index").map_err(|e|e.to_string())?;
                let entries=updates.query_map([&b.id],|r|Ok((r.get::<_,usize>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e|e.to_string())?;
                for entry in entries{
                    let (index,phase,raw)=entry.map_err(|e|e.to_string())?;
                    let item:OcrRenameItem=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
                    let slot=b.items.get_mut(index).filter(|old|old.file_id==item.file_id).ok_or("改名记录索引不一致")?;
                    *slot=item;b.status=phase;recovered=true;
                }
                for item in &mut b.items {
                    let undo=item.status=="undoing";
                    if !undo && item.status!="applying"{continue;}
                    recovered=true;
                    let original=Path::new(&item.original);
                    let target=Path::new(&item.target);
                    let matches=|path:&Path|fingerprint(path).ok().as_deref()==Some(&item.fingerprint);
                    item.status=if original==target && matches(original){
                        if undo{"undone"}else{"done"}
                    }else if !original.exists() && matches(target){"done"}
                    else if !target.exists() && matches(original){if undo{"undone"}else{"pending"}}
                    else{"conflict"}.into();
                    if item.status=="conflict"{item.error="文件位置或内容已变化，请核对上次中断的操作".into();}
                    else{item.error.clear();}
                }
                if !b.status.starts_with("rollback")&&b.items.iter().any(|i|i.status=="undone"){b.status="rollback".into();recovered=true;}if b.status=="preview"&&b.items.iter().any(|i|i.status=="done"){b.status="interrupted".into();recovered=true;}b.summarize();if recovered{
                    if let Some(task)=tasks.get_mut(&b.task_id){
                        for item in &b.items{
                            let (old,new)=match item.status.as_str(){"done"=>(&item.original,&item.target),"undone"=>(&item.target,&item.original),_=>continue};
                            if let Some((i,file))=task.files.iter_mut().enumerate().find(|(_,f)|f.id==item.file_id&&f.path==*old&&f.path!=*new){
                                if fingerprint(Path::new(new)).ok().as_deref()==Some(&item.fingerprint){
                                    file.path=new.clone();grants.insert(new.clone());recovered_tasks.push((task.id.clone(),vec![i]));
                                }
                            }
                        }
                    }
                    recovered_batches.push(b.id.clone());
                }batches.insert(b.id.clone(),b);}
        }
        let store=Self{dir:ocr,exe,data:Mutex::new(Data{profiles,tasks,batches,grants,queue:VecDeque::new(),running:false}),cancels:Mutex::new(HashMap::new()),proposals:Default::default(),db:Mutex::new(db),unavailable_reason:None};
        {let data=store.data.lock().unwrap();for (id,files) in recovered_tasks{let task=&data.tasks[&id];for index in files{store.save_task_file(task,index)?;}store.save_task_header(task)?;}for id in recovered_batches{store.save_batch(&data.batches[&id])?;}}
        Ok(store)
    }
    pub fn save_profiles(&self,p:&[OcrProfile])->Result<(),String>{self.ensure_available()?;let path=self.dir.join("profiles.json");if let Ok(bytes)=std::fs::read(&path){if let Ok(old)=serde_json::from_slice::<Vec<OcrProfile>>(&bytes){if old.iter().all(|v|rules::validate(v).is_ok()){atomic_json(&self.dir.join("profiles.previous.json"),&old)?;}}}atomic_json(&path,&p)}
    pub fn save_task(&self,t:&OcrTask)->Result<(),String>{self.ensure_available()?;for f in &t.files{atomic_json(&file_path(&self.dir,&t.id,&f.id),&stored_file(f))?;}self.save_task_header(t)}
    pub fn save_task_file(&self,t:&OcrTask,index:usize)->Result<(),String>{self.ensure_available()?;let f=t.files.get(index).ok_or("文件不存在")?;atomic_json(&file_path(&self.dir,&t.id,&f.id),&stored_file(f))}
    pub fn save_task_header(&self,t:&OcrTask)->Result<(),String>{self.ensure_available()?;atomic_json(&self.dir.join(format!("task-{}.json",t.id)),&StoredTask::from_task(t))?;self.db.lock().unwrap().execute("INSERT OR REPLACE INTO ocr_tasks VALUES(?1,?2,?3,?4)",params![t.id,t.created,t.status,t.files.len()]).map_err(|e|e.to_string())?;Ok(())}
    pub fn delete_task_files(&self,t:&OcrTask){let _=std::fs::remove_file(self.dir.join(format!("task-{}.json",t.id)));for f in &t.files{let _=std::fs::remove_file(file_path(&self.dir,&t.id,&f.id));}}
    pub fn save_batch(&self,b:&OcrRenameBatch)->Result<(),String>{
        self.ensure_available()?;
        let mut db=self.db.lock().unwrap();
        let tx=db.transaction().map_err(|e|e.to_string())?;
        tx.execute("INSERT OR REPLACE INTO ocr_renames VALUES(?1,?2)",params![b.id,serde_json::to_string(b).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM ocr_rename_updates WHERE batch_id=?1",[&b.id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
    }
    pub fn save_rename_item(&self,b:&OcrRenameBatch,index:usize)->Result<(),String>{
        self.ensure_available()?;
        let item=serde_json::to_string(&b.items[index]).map_err(|e|e.to_string())?;
        self.db.lock().unwrap().execute("INSERT OR REPLACE INTO ocr_rename_updates(batch_id,item_index,phase,item) VALUES(?1,?2,?3,?4)",
            params![b.id,index,b.status,item]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn delete_task_db(&self,id:&str)->Result<(),String>{self.ensure_available()?;self.db.lock().unwrap().execute("DELETE FROM ocr_tasks WHERE id = ?1",params![id]).map_err(|e|e.to_string())?;Ok(())}
}
pub fn supported(p:&Path)->bool{p.extension().is_some_and(|e|["pdf","png","jpg","jpeg","bmp","tif","tiff"].contains(&e.to_string_lossy().to_lowercase().as_str()))}
pub fn safe_file(path:&Path)->Result<PathBuf,String>{
    let meta=std::fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Err("不处理链接或重解析文件，请选择实际文件".into());}}
    if !meta.is_file()||!supported(path){return Err("请选择 PDF、PNG、JPEG、BMP 或 TIFF 文件".into());}
    if meta.len()>512*1024*1024{return Err("文件超过 512 MB".into());}
    path.canonicalize().map_err(|e|e.to_string())
}
pub fn fingerprint(path:&Path)->Result<String,String>{
    let path=safe_file(path)?;let mut file=std::fs::File::open(path).map_err(|e|e.to_string())?;let before=file.metadata().map_err(|e|e.to_string())?;
    let created_ts=before.created().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs()).unwrap_or(0);
    let mut hash=Sha256::new();hash.update(before.len().to_le_bytes());hash.update(created_ts.to_le_bytes());
    #[cfg(windows)]{use std::os::windows::io::AsRawHandle;#[repr(C)]struct Info{attrs:u32,creation:[u32;2],access:[u32;2],write:[u32;2],volume:u32,size_hi:u32,size_lo:u32,links:u32,index_hi:u32,index_lo:u32}#[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(h:*mut std::ffi::c_void,i:*mut Info)->i32;}let mut info=std::mem::MaybeUninit::<Info>::uninit();if unsafe{GetFileInformationByHandle(file.as_raw_handle(),info.as_mut_ptr())}==0{return Err(std::io::Error::last_os_error().to_string());}let info=unsafe{info.assume_init()};hash.update(info.volume.to_le_bytes());hash.update(info.index_hi.to_le_bytes());hash.update(info.index_lo.to_le_bytes());}
    let mut buf=[0u8;65536];loop{let n=file.read(&mut buf).map_err(|e|e.to_string())?;if n==0{break;}hash.update(&buf[..n]);}
    let after=file.metadata().map_err(|e|e.to_string())?;if before.len()!=after.len()||before.modified().ok()!=after.modified().ok(){return Err("文件在读取期间发生变化".into());}Ok(format!("{:x}",hash.finalize()))
}
pub fn move_no_replace(from:&Path,to:&Path)->Result<(),String>{
    if to.exists(){return Err("目标已经存在，未覆盖".into());}
    #[cfg(windows)]{use std::os::windows::ffi::OsStrExt;#[link(name="kernel32")]extern "system"{fn MoveFileExW(a:*const u16,b:*const u16,flags:u32)->i32;}let a:Vec<u16>=from.as_os_str().encode_wide().chain(Some(0)).collect();let b:Vec<u16>=to.as_os_str().encode_wide().chain(Some(0)).collect();if unsafe{MoveFileExW(a.as_ptr(),b.as_ptr(),0)}==0{return Err(std::io::Error::last_os_error().to_string());}Ok(())}
    #[cfg(not(windows))]{std::fs::hard_link(from,to).map_err(|e|e.to_string())?;std::fs::remove_file(from).map_err(|e|e.to_string())}
}
