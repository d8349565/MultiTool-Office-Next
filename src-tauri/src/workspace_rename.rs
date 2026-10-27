//! Explicit workspace UI operations. These commands are deliberately absent from AI tools.
use crate::{assistant_fs, index::Index, AppState};
use serde::{Deserialize, Serialize};
use std::{fs::File, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};
#[cfg(all(test,windows))]
#[path="workspace_rename_tests.rs"]
mod tests;

#[derive(Default)]
pub struct Renames(pub Mutex<()>);

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct Record {
    pub id:String, pub original:String, pub target:String, pub is_dir:bool,
    pub created:u64, pub status:String, pub error:String, pub warning:String,
    pub extension_changed:bool, parent_identity:String, fingerprint:String,
}
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn warn(r:&mut Record,message:String){if !r.warning.is_empty(){r.warning.push_str("；");}r.warning.push_str(&message);}
fn key(path:&Path)->String{path.to_string_lossy().trim_start_matches("\\\\?\\").replace('/',"\\").to_lowercase()}
pub(crate) fn affects(path:&str,original:&str,target:&str)->bool{
    let path=key(Path::new(path));[original,target].iter().any(|p|{let p=key(Path::new(p));path==p||path.starts_with(&(p+"\\"))})
}
pub fn init(index:&Index)->Result<(),String>{
    // The journal uses the existing per-user app database, never document contents.
    index.db.lock().unwrap().execute_batch("CREATE TABLE IF NOT EXISTS workspace_renames(id TEXT PRIMARY KEY,created INTEGER NOT NULL,data TEXT NOT NULL);").map_err(|e|e.to_string())
}
fn save(index:&Index,r:&Record)->Result<(),String>{
    index.db.lock().unwrap().execute("INSERT OR REPLACE INTO workspace_renames VALUES(?1,?2,?3)",rusqlite::params![r.id,r.created,serde_json::to_string(r).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;Ok(())
}
fn load(index:&Index,id:&str)->Result<Record,String>{
    let raw:String=index.db.lock().unwrap().query_row("SELECT data FROM workspace_renames WHERE id=?1",[id],|row|row.get(0)).map_err(|_|"改名记录不存在，请重新预览")?;
    serde_json::from_str(&raw).map_err(|e|e.to_string())
}
pub(crate) fn validate_name(name:&str)->Result<(),String>{
    if name.is_empty()||name=="."||name==".."||name.encode_utf16().count()>255||name.ends_with([' ','.'])||name.chars().any(|c|c.is_control()||"\\/:*?\"<>|".contains(c)||matches!(c,'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{feff}')){
        return Err("请输入同一目录内的普通名称；不能包含路径、非法字符、尾部点或空格，名称最多 255 个 UTF-16 字符".into());
    }
    let stem=name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    if ["CON","PRN","AUX","NUL","CLOCK$","CONIN$","CONOUT$"].contains(&stem.as_str())||["COM","LPT"].iter().any(|prefix|stem.strip_prefix(prefix).is_some_and(|n|["1","2","3","4","5","6","7","8","9","¹","²","³"].contains(&n))){return Err("Windows 保留设备名称不可用".into());}Ok(())
}
fn absent(path:&Path)->Result<(),String>{
    match std::fs::symlink_metadata(path){Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Ok(_)=>Err("目标名称已被占用（包括大小写冲突或链接），未覆盖任何文件".into()),Err(e)=>Err(format!("无法确认目标是否可用：{e}"))}
}
fn plain(path:&Path)->Result<PathBuf,String>{
    let text=path.to_str().ok_or("路径编码无效")?;let path=PathBuf::from(text.strip_prefix("\\\\?\\").unwrap_or(text));
    assistant_fs::root_path(&path)?;Ok(path)
}
fn record_paths(r:&Record)->Result<(PathBuf,PathBuf),String>{
    let original=plain(Path::new(&r.original))?;let target=plain(Path::new(&r.target))?;
    if original.parent()!=target.parent()||key(&original)==key(&target){return Err("改名计划不再是同一目录内的名称变更，请人工核对".into());}
    validate_name(original.file_name().and_then(|v|v.to_str()).ok_or("原名称无效")?)?;
    validate_name(target.file_name().and_then(|v|v.to_str()).ok_or("目标名称无效")?)?;
    Ok((original,target))
}

#[cfg(windows)]
fn open_source(path:&Path,for_rename:bool)->Result<File,String>{
    use std::{fs::OpenOptions,os::windows::fs::OpenOptionsExt};
    let file=OpenOptions::new().access_mode(0x80|if for_rename{0x10000}else{0}).share_mode(if for_rename{1}else{5}).custom_flags(0x02000000|0x00200000).open(path)
        .map_err(|e|format!("无法安全锁定目标；请关闭占用文件的程序并检查权限（不会自动提权）：{e}"))?;
    let (actual,_,attributes,links)=assistant_fs::information(&file)?;
    if key(&actual)!=key(path)||attributes&0x405!=0||(!file.metadata().map_err(|e|e.to_string())?.is_dir()&&links!=1){return Err("不处理系统/只读文件、符号链接、目录联接、硬链接或实际位置已变化的对象".into());}
    Ok(file)
}
#[cfg(not(windows))]
fn open_source(_: &Path,_:bool)->Result<File,String>{Err("安全改名目前仅支持 Windows 桌面版".into())}

// The source cannot be replaced while its rename handle is held. Descendant
// handles stabilize metadata checks and are released immediately before moving,
// as Windows can refuse a directory rename while its children are open.
// This does not transactionally freeze other programs. No bodies are read.
struct Snapshot {fingerprint:String,max_relative_len:usize,_files:Vec<File>}
fn check_length(target:&Path,snapshot:&Snapshot)->Result<(),String>{
    let length=target.as_os_str().to_string_lossy().encode_utf16().count()+if snapshot.max_relative_len==0{0}else{1+snapshot.max_relative_len};
    if length>240{return Err("改名后的完整路径或子项路径超过 240 个 UTF-16 字符，请缩短名称；暂不支持长路径改名".into());}Ok(())
}
#[cfg(windows)]
fn snapshot(path:&Path,file:&File)->Result<Snapshot,String>{
    use sha2::{Digest,Sha256};
    use std::os::windows::{fs::MetadataExt,io::AsRawHandle};
    use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{GetFileInformationByHandleEx,FileBasicInfo,FILE_BASIC_INFO}};
    fn stamp(hash:&mut Sha256,file:&File,relative:&Path)->Result<(),String>{
        let (_,identity,attrs,_)=assistant_fs::information(file)?;let m=file.metadata().map_err(|e|e.to_string())?;
        let mut basic=FILE_BASIC_INFO::default();
        unsafe{GetFileInformationByHandleEx(HANDLE(file.as_raw_handle()),FileBasicInfo,(&mut basic as *mut FILE_BASIC_INFO).cast(),std::mem::size_of::<FILE_BASIC_INFO>() as u32)}.map_err(|e|format!("无法核对 Windows 文件变更时间，未操作：{e}"))?;
        if basic.ChangeTime<=0{return Err("该文件系统未提供可靠的 Windows 变更时间，暂不支持安全改名".into());}
        let row=serde_json::to_vec(&(relative.to_string_lossy(),identity,attrs,m.file_size(),m.creation_time(),m.last_write_time(),basic.ChangeTime)).map_err(|e|e.to_string())?;
        hash.update((row.len() as u64).to_le_bytes());hash.update(row);Ok(())
    }
    let mut hash=Sha256::new();stamp(&mut hash,file,Path::new(""))?;let mut files=vec![];let mut max_relative_len=0;
    if file.metadata().map_err(|e|e.to_string())?.is_dir(){
        // ponytail: cap metadata/handle work at 10,000 descendants; larger trees
        // need a bounded, persisted snapshot design before this limit is raised.
        for item in walkdir::WalkDir::new(path).min_depth(1).follow_links(false).follow_root_links(false).sort_by_file_name(){
            let item=item.map_err(|e|format!("目录无法完整核对，未改名：{e}"))?;
            if files.len()>=10_000{return Err("目录超过 10,000 个子项，暂不支持安全改名；请使用系统文件管理器".into());}
            let relative=item.path().strip_prefix(path).map_err(|e|e.to_string())?;
            max_relative_len=max_relative_len.max(relative.to_string_lossy().encode_utf16().count());
            let child=open_source(item.path(),false)?;stamp(&mut hash,&child,relative)?;files.push(child);
        }
        // Detect additions/removals while the traversal was being collected.
        let mut count=0;
        for item in walkdir::WalkDir::new(path).min_depth(1).follow_links(false).follow_root_links(false){item.map_err(|e|e.to_string())?;count+=1;if count>files.len(){return Err("目录在核对期间发生变化，请停止其他文件操作后重试".into());}}
        if count!=files.len(){return Err("目录在核对期间发生变化，请重试".into());}
    }
    Ok(Snapshot{fingerprint:format!("{:x}",hash.finalize()),max_relative_len,_files:files})
}
#[cfg(not(windows))]
fn snapshot(_: &Path,_:&File)->Result<Snapshot,String>{Err("安全改名目前仅支持 Windows 桌面版".into())}

#[cfg(windows)]
fn move_handle(file:&File,target:&Path)->Result<(),String>{
    use std::os::windows::{ffi::OsStrExt,io::AsRawHandle};
    use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{SetFileInformationByHandle,FileRenameInfo,FILE_RENAME_INFO}};
    // FILE_RENAME_INFO requires an aligned, variable-length buffer. The parent
    // directory is locked by Directory::lock, and ReplaceIfExists stays false.
    let name:Vec<u16>=target.as_os_str().encode_wide().chain(Some(0)).collect();
    let bytes=std::mem::size_of::<FILE_RENAME_INFO>()+name.len()*2;let mut buffer=vec![0u64;bytes.div_ceil(8)];
    let info=buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe{
        (*info).FileNameLength=((name.len()-1)*2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(),std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),name.len());
        SetFileInformationByHandle(HANDLE(file.as_raw_handle()),FileRenameInfo,info.cast(),bytes as u32)
    }.map_err(|e|format!("Windows 拒绝改名，目标未被覆盖；请检查名称冲突、文件占用或权限：{e}"))
}
#[cfg(not(windows))]
fn move_handle(_: &File,_:&Path)->Result<(),String>{Err("安全改名目前仅支持 Windows 桌面版".into())}

fn preview(index:&Index,path:&str,new_name:&str,is_dir:bool,allow_extension_change:bool)->Result<Record,String>{
    validate_name(new_name)?;
    let original=plain(Path::new(path))?;let authorized=plain(&index.authorize(path)?)?;
    if key(&original)!=key(&authorized){return Err("目标通过链接或目录联接访问，请选择实际位置".into());}
    let original=authorized;
    let parent=assistant_fs::Directory::lock(original.parent().ok_or("路径没有父目录")?)?;
    let roots=index.roots.read().unwrap();
    if !roots.iter().any(|r|key(&original).starts_with(&(key(r)+"\\")))||roots.iter().any(|r|affects(&r.to_string_lossy(),&original.to_string_lossy(),&original.to_string_lossy())){return Err("不能改名工作根目录、包含其他工作根目录的目录或授权范围外的对象".into());}
    let source=open_source(&original,true)?;
    if source.metadata().map_err(|e|e.to_string())?.is_dir()!=is_dir{return Err("目标类型已变化，请重新选择".into());}
    let target=original.parent().unwrap().join(new_name);
    if key(&original)==key(&target){return Err("新旧名称相同，或仅有大小写变化；暂不支持只调整大小写".into());}
    assistant_fs::root_path(&target)?;
    let extension_changed=!is_dir&&original.extension().map(|v|v.to_string_lossy().to_lowercase())!=target.extension().map(|v|v.to_string_lossy().to_lowercase());
    if extension_changed&&!allow_extension_change{return Err("默认保留扩展名；如需修改，请勾选修改扩展名并核对打开方式风险".into());}
    absent(&target)?;let snapshot=snapshot(&original,&source)?;check_length(&target,&snapshot)?;
    let r=Record{id:uuid::Uuid::new_v4().to_string(),original:original.to_string_lossy().into_owned(),target:target.to_string_lossy().into_owned(),is_dir,created:now(),status:"preview".into(),error:String::new(),warning:String::new(),extension_changed,parent_identity:parent.identity.clone(),fingerprint:snapshot.fingerprint};
    save(index,&r)?;Ok(r)
}

fn execute(index:&Index,r:&mut Record,undo:bool,before:impl FnOnce()->Result<(),String>)->Result<(),String>{
    let (original,target)=record_paths(r)?;
    let (from,to)=if undo{(target,original)}else{(original,target)};
    // Serialize against scans and hold the authorization snapshot through the move.
    let _mutation=index.mutation.try_lock().map_err(|_|"索引正在更新，请完成后再改名或撤销")?;let roots=index.roots.read().unwrap();
    if !roots.iter().any(|root|key(&from).starts_with(&(key(root)+"\\")))||roots.iter().any(|root|affects(&root.to_string_lossy(),&from.to_string_lossy(),&from.to_string_lossy())){return Err("工作目录授权已变化或目标包含工作根目录，请重新选择".into());}
    let parent=assistant_fs::Directory::lock(from.parent().ok_or("路径无父目录")?)?;
    if parent.identity!=r.parent_identity{return Err("父目录身份已变化，未操作，请重新选择".into());}
    let file=open_source(&from,true)?;let source_snapshot=snapshot(&from,&file)?;
    if source_snapshot.fingerprint!=r.fingerprint{return Err("对象身份、文件状态或目录子项已变化，未操作；请重新预览或人工处理".into());}
    check_length(&to,&source_snapshot)?;
    absent(&to)?;before()?;
    if r.is_dir&&snapshot(&from,&file)?.fingerprint!=r.fingerprint{return Err("目录在确认期间发生变化，未改名，请重新预览".into());}
    r.status=if undo{"undoing"}else{"applying"}.into();r.error.clear();r.warning.clear();save(index,r)?;
    drop(source_snapshot);
    move_handle(&file,&to)?;
    // No further filesystem writes after success. If journaling fails, the saved
    // intent remains recoverable and must never be reported as an ordinary failure.
    r.status=if undo{"undone"}else{"done"}.into();
    match snapshot(&to,&file){
        Ok(after)=>r.fingerprint=after.fingerprint,
        Err(error)=>{r.fingerprint.clear();warn(r,format!("文件操作已完成，但结果状态无法完整核对，禁止自动撤销，请人工处理：{error}"));}
    }
    if let Err(e)=index.renamed(&PathBuf::from(index_path(&from)),&PathBuf::from(index_path(&to))){warn(r,format!("改名已完成，索引保存失败：{e}"));let _=index.refresh.send(());}
    if let Err(e)=save(index,r){warn(r,format!("文件操作已完成，结果日志保存失败；请在改名记录中核对中断状态：{e}"));}
    Ok(())
}
fn index_path(path:&Path)->String{
    #[cfg(windows)] {format!("\\\\?\\{}",path.to_string_lossy())}
    #[cfg(not(windows))] {path.to_string_lossy().into_owned()}
}
fn recover(index:&Index,r:&mut Record)->Result<(),String>{
    if !["applying","undoing"].contains(&r.status.as_str()){return Err("此记录没有待核对的中断操作".into());}
    let _mutation=index.mutation.try_lock().map_err(|_|"索引正在更新，请完成后再核对")?;
    let (original,target)=record_paths(r)?;let original=original.as_path();let target=target.as_path();
    let roots=index.roots.read().unwrap();
    if !roots.iter().any(|root|key(original).starts_with(&(key(root)+"\\"))){return Err("记录已超出当前工作目录授权范围，未核对文件".into());}
    let parent=assistant_fs::Directory::lock(original.parent().unwrap())?;
    if parent.identity!=r.parent_identity{return Err("父目录已变化，请人工核对，未操作文件".into());}
    let matched=|path:&Path|->bool{open_source(path,true).and_then(|f|snapshot(path,&f)).is_ok_and(|s|s.fingerprint==r.fingerprint)};
    if absent(original).is_ok()&&matched(target){r.status="done".into();}
    else if absent(target).is_ok()&&matched(original){r.status=if r.status=="undoing"{"undone"}else{"failed"}.into();}
    else{return Err("两端路径或对象状态无法安全确认，请人工核对；没有移动、覆盖或删除任何文件".into());}
    r.error="已核对上次中断的操作；仅在对象和原名仍可用时允许撤销".into();save(index,r)?;let _=index.refresh.send(());Ok(())
}

#[tauri::command]
pub async fn workspace_rename_preview(state:tauri::State<'_,Arc<AppState>>,path:String,new_name:String,is_dir:bool,allow_extension_change:bool)->Result<Record,String>{
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
        let _operation=state.workspace_renames.0.try_lock().map_err(|_|"另一个改名操作正在执行，请稍后重试")?;
        let d=state.ocr.data.try_lock().map_err(|_|"OCR 正在更新，请稍后重试")?;
        if d.running||!d.queue.is_empty(){return Err("OCR 任务正在运行或收尾，请结束后再改名".into());}
        preview(&state.index,&path,&new_name,is_dir,allow_extension_change)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn workspace_rename_apply(state:tauri::State<'_,Arc<AppState>>,id:String,action:String)->Result<Record,String>{
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
        let _operation=state.workspace_renames.0.try_lock().map_err(|_|"另一个改名操作正在执行，请勿重复点击")?;
        let mut d=state.ocr.data.try_lock().map_err(|_|"OCR 正在更新，请稍后重试")?;
        if d.running||!d.queue.is_empty(){return Err("OCR 任务正在运行或收尾，请结束后再改名或撤销".into());}
        let mut r=load(&state.index,&id)?;
        if action=="recover"{recover(&state.index,&mut r)?;return Ok(r);}
        let undo=match action.as_str(){"apply"=>false,"undo"=>true,_=>return Err("未知的改名操作".into())};
        if undo&&r.status!="done"||!undo&&r.status!="preview"{return Err("记录状态已变化，不能重复执行；请刷新改名记录".into());}
        if !undo&&now().saturating_sub(r.created)>600{return Err("预览已超过 10 分钟，请重新预览后确认".into());}
        let original=r.original.clone();let target=r.target.clone();
        if let Err(error)=execute(&state.index,&mut r,undo,||crate::ocr::invalidate_workspace_paths(&state.ocr,&mut d,&original,&target)){
            // If intent was saved, native failure is known (and nothing moved).
            r.status=if undo{"done"}else{"failed"}.into();r.error=error;
            if let Err(e)=save(&state.index,&r){return Err(format!("{}；日志保存失败：{e}",r.error));}
        }
        Ok(r)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn workspace_rename_history(state:tauri::State<'_,Arc<AppState>>)->Result<Vec<Record>,String>{
    let index=state.index.clone();tauri::async_runtime::spawn_blocking(move||{
        let db=index.db.lock().unwrap();let mut stmt=db.prepare("SELECT data FROM workspace_renames ORDER BY created DESC,rowid DESC").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?;
        let mut records=vec![];for row in rows{let r:Record=serde_json::from_str(&row.map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;if r.status!="preview"{records.push(r);if records.len()==50{break;}}}Ok(records)
    }).await.map_err(|e|e.to_string())?
}
