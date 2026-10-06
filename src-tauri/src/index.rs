use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, sync::{Arc, Mutex, RwLock, mpsc}, time::{Duration, Instant, UNIX_EPOCH}};
use notify::{Watcher, RecursiveMode};
use rusqlite::{Connection, params};
use walkdir::WalkDir;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct Entry { pub path: String, pub name: String, pub parent: String, pub extension: String, pub size: u64, pub modified: u64, #[serde(default)] pub created: Option<u64>, pub is_dir: bool, #[serde(skip)] pub searchable: String, #[serde(skip)] pub sort_key: Vec<u8> }
impl Entry {
    pub fn from_path(path: &Path) -> Option<Self> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        if is_link(&meta) { return None; }
        let name = path.file_name()?.to_string_lossy().into_owned();
        if !meta.is_dir() && temporary_name(&name) { return None; }
        let p = path.to_string_lossy().into_owned();
        Some(Self {sort_key:name_sort_key(&name),searchable:p.to_lowercase(),path:p,name,parent:path.parent()?.to_string_lossy().into_owned(),extension:path.extension().map(|s|s.to_string_lossy().to_lowercase()).unwrap_or_default(),size:meta.len(),modified:meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs(),created:meta.created().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs()),is_dir:meta.is_dir()})
    }
}
pub fn temporary_name(name:&str)->bool {
    let name=name.to_ascii_lowercase();
    name.starts_with("~$") || name.starts_with(".~lock.") || name.ends_with(".tmp")
}
pub fn name_sort_key(name:&str)->Vec<u8> {
    #[cfg(windows)] {
        #[link(name="kernel32")]
        extern "system" { fn LCMapStringEx(locale:*const u16,flags:u32,source:*const u16,length:i32,dest:*mut u16,size:i32,version:*const std::ffi::c_void,reserved:*const std::ffi::c_void,handle:isize)->i32; }
        let locale:Vec<u16>="zh-CN\0".encode_utf16().collect();
        let source:Vec<u16>=name.encode_utf16().collect();
        // Sort keys are bytes; SORT_DIGITSASNUMBERS gives natural number order.
        unsafe {
            let flags=0x400|0x8|0x1;
            let size=LCMapStringEx(locale.as_ptr(),flags,source.as_ptr(),source.len() as i32,std::ptr::null_mut(),0,std::ptr::null(),std::ptr::null(),0);
            if size>0 {let mut key=vec![0u8;size as usize];if LCMapStringEx(locale.as_ptr(),flags,source.as_ptr(),source.len() as i32,key.as_mut_ptr().cast(),size,std::ptr::null(),std::ptr::null(),0)>0{return key;}}
        }
    }
    name.to_lowercase().into_bytes()
}
fn is_link(meta:&std::fs::Metadata)->bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { meta.file_type().is_symlink() }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status { pub scanning: bool, pub count: usize, pub scanned: usize, pub errors: Vec<String>, pub generation: u64 }
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all="camelCase", default)]
pub struct Query {pub query:String,pub kind:String,pub root:Option<String>,pub recursive:bool,pub filter:String,pub extension:String,pub after:Option<u64>,pub before:Option<u64>,pub offset:usize,pub limit:usize}
#[derive(Serialize)] pub struct Results {pub items:Vec<Entry>,pub total:usize}
pub trait SearchProvider { fn search(&self, query: &Query) -> Results; }
pub struct Index {
    pub entries: RwLock<Vec<Entry>>, pub status: Mutex<Status>,
    pub roots: RwLock<Vec<PathBuf>>, pub db: Mutex<Connection>,
    cache: Mutex<HashMap<String,(Instant,Vec<Entry>)>>, pub refresh: mpsc::Sender<()>,
}
pub fn normalize(path:&Path)->Result<PathBuf,String> { path.canonicalize().map_err(|e|if e.kind()==std::io::ErrorKind::NotFound {format!("路径已不存在：{}",path.display())}else{format!("{}：{e}",path.display())}) }
pub fn within(path:&Path, root:&Path)->bool { path.starts_with(root) }
fn valid_root(root:&Path)->Result<(),String> {
    let meta=std::fs::symlink_metadata(root).map_err(|e|format!("{}：{e}",root.display()))?;
    if is_link(&meta) || !meta.is_dir() {return Err(format!("目录已成为链接或不再是目录：{}",root.display()));}
    let canonical=normalize(root)?;
    let key=|p:&Path|p.to_string_lossy().trim_start_matches("\\\\?\\").replace('/',"\\").to_lowercase();
    if key(&canonical)!=key(root) {return Err(format!("目录实际位置已变化，请重新选择：{}",root.display()));} Ok(())
}
impl Index {
    pub fn open(dir:&Path)->Result<(Arc<Self>,mpsc::Receiver<()>),String> {
        let db=Connection::open(dir.join("office.sqlite")).map_err(|e|e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, kind TEXT, status TEXT, elapsed_ms INTEGER, model TEXT, usage TEXT, created INTEGER);").map_err(|e|e.to_string())?;
        crate::task_state::init(&db)?;
        let (tx,rx)=mpsc::channel();
        Ok((Arc::new(Self{entries:RwLock::new(vec![]),status:Mutex::new(Status::default()),roots:RwLock::new(vec![]),db:Mutex::new(db),cache:Mutex::new(HashMap::new()),refresh:tx}),rx))
    }
    fn load_cached(&self)->Result<(),String> {
        let entries={let db=self.db.lock().unwrap();let mut stmt=db.prepare("SELECT data FROM files").map_err(|e|e.to_string())?;
            let result=stmt.query_map([],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?.filter_map(Result::ok).filter_map(|s|serde_json::from_str::<Entry>(&s).ok()).map(|mut e|{e.searchable=e.path.to_lowercase();e.sort_key=name_sort_key(&e.name);e}).collect::<Vec<_>>();result};
        let count=entries.len();*self.entries.write().unwrap()=entries;
        let mut status=self.status.lock().unwrap();status.count=count;status.scanned=count;status.generation+=1;Ok(())
    }
    pub fn authorize(&self,path:&str)->Result<PathBuf,String> {
        let p=normalize(Path::new(path))?;
        if !self.roots.read().unwrap().iter().any(|r|within(&p,r)) {return Err("路径不在已配置的目录范围内".into());} Ok(p)
    }
    pub fn snapshot_search(&self,q:&Query)->Results {
        let tokens=q.query.to_lowercase().split_whitespace().map(str::to_owned).collect::<Vec<_>>();let filter=q.filter.to_lowercase();let ext=q.extension.trim_start_matches('.').to_lowercase();
        let roots=self.roots.read().unwrap();let entries=self.entries.read().unwrap();let scope=q.root.as_deref().map(Path::new);
        let mut items=entries.iter().filter(|e|{let p=Path::new(&e.path);
            (if q.kind=="directory"{e.is_dir}else{!e.is_dir&&!temporary_name(&e.name)})&&roots.iter().any(|r|within(p,r))&&scope.is_none_or(|r|if q.recursive{within(p,r)&&p!=r}else{Path::new(&e.parent)==r})&&tokens.iter().all(|t|e.searchable.contains(t))&&e.searchable.contains(&filter)&&(ext.is_empty()||e.extension==ext)&&q.after.is_none_or(|a|e.modified>=a)&&q.before.is_none_or(|b|e.modified<=b)
        }).cloned().collect::<Vec<_>>();
        items.sort_unstable_by(|a,b|a.sort_key.cmp(&b.sort_key).then_with(||a.path.cmp(&b.path)));Results{total:items.len(),items}
    }
    pub fn dirs(&self,path:&str)->Result<Vec<Entry>,String> {
        let p=self.authorize(path)?;let key=p.to_string_lossy().into_owned();
        if let Some((time,items))=self.cache.lock().unwrap().get(&key) {if time.elapsed()<Duration::from_secs(2){return Ok(items.clone());}}
        let mut items=std::fs::read_dir(&p).map_err(|e|if e.kind()==std::io::ErrorKind::NotFound {format!("路径已不存在：{}",p.display())}else{e.to_string()})?.filter_map(Result::ok).filter_map(|e|Entry::from_path(&e.path())).filter(|e|e.is_dir).collect::<Vec<_>>();
        items.sort_by(|a,b|a.sort_key.cmp(&b.sort_key).then_with(||a.path.cmp(&b.path)));
        let mut cache=self.cache.lock().unwrap(); if cache.len()>300 {cache.clear();} cache.insert(key,(Instant::now(),items.clone()));Ok(items)
    }
    pub fn configure(&self, roots:&[String]) {
        *self.roots.write().unwrap()=roots.iter().map(|r|normalize(Path::new(r)).unwrap_or_else(|_|PathBuf::from(r))).collect();
        let _=self.refresh.send(());
    }
    fn persist(&self, items:&[Entry], remove:&[String], reset:bool)->Result<(),String>{
        let mut db=self.db.lock().unwrap();let tx=db.transaction().map_err(|e|e.to_string())?;
        if reset {tx.execute("DELETE FROM files",[]).map_err(|e|e.to_string())?;}
        {let mut del=tx.prepare("DELETE FROM files WHERE path=?1").map_err(|e|e.to_string())?;for p in remove {del.execute([p]).map_err(|e|e.to_string())?;}}
        {let mut put=tx.prepare("INSERT OR REPLACE INTO files(path,data) VALUES(?1,?2)").map_err(|e|e.to_string())?;for e in items {put.execute(params![e.path,serde_json::to_string(e).unwrap()]).map_err(|e|e.to_string())?;}}
        tx.commit().map_err(|e|e.to_string())
    }
    fn error(&self,msg:String){let mut s=self.status.lock().unwrap();if s.errors.len()<20 {s.errors.push(msg);}}
    fn scan(&self) {
        {let mut s=self.status.lock().unwrap();s.scanning=true;s.scanned=0;s.errors.clear();}
        let roots=self.roots.read().unwrap().clone();let mut files=HashMap::new();let mut batch=vec![];
        for root in &roots {
            if let Err(e)=valid_root(root){self.error(e);continue;}
            for item in WalkDir::new(root).follow_links(false).follow_root_links(false).into_iter().filter_entry(|e| e.metadata().is_ok_and(|m|!is_link(&m))) {
                if *self.roots.read().unwrap()!=roots {self.status.lock().unwrap().scanning=false;return;}
                match item {
                    Ok(item)=>if let Some(entry)=Entry::from_path(item.path()) {files.insert(entry.path.clone(),entry.clone());batch.push(entry);},
                    Err(e)=>self.error(e.to_string()),
                }
                if batch.len()>=1000 {
                    self.merge(&batch,&[]);batch.clear();let mut s=self.status.lock().unwrap();s.scanned=files.len();
                }
            }
        }
        let mut files=files.into_values().collect::<Vec<_>>();files.sort_by(|a,b|a.path.cmp(&b.path));
        if let Err(e)=self.persist(&files,&[],true){self.error(e);}
        *self.entries.write().unwrap()=files;
        let mut s=self.status.lock().unwrap();s.count=self.entries.read().unwrap().len();s.scanned=s.count;s.scanning=false;s.generation+=1;
    }
    fn merge(&self, additions:&[Entry], removed:&[PathBuf]) {
        let replacement:HashSet<&str>=additions.iter().map(|e|e.path.as_str()).collect();
        let mut entries=self.entries.write().unwrap();entries.retain(|e| !replacement.contains(e.path.as_str()) && !removed.iter().any(|p|Path::new(&e.path).starts_with(p)));entries.extend_from_slice(additions);
    }
    fn update(&self,paths:HashSet<PathBuf>) {
        self.cache.lock().unwrap().clear();let roots=self.roots.read().unwrap().clone();
        let paths=paths.into_iter().filter(|p|roots.iter().any(|r|within(p,r))).collect::<Vec<_>>();
        let mut fresh=HashMap::new();
        for p in &paths {
            if p.exists() {
                // Canonicalize before reading: never index a newly introduced junction outside roots.
                if !normalize(p).is_ok_and(|p|roots.iter().any(|r|within(&p,r))) {continue;}
                for e in WalkDir::new(p).follow_links(false).follow_root_links(false).into_iter().filter_entry(|e|e.metadata().is_ok_and(|m|!is_link(&m))).filter_map(Result::ok) {
                    if let Some(item)=Entry::from_path(e.path()) {fresh.insert(item.path.clone(),item);}
                }
            }
        }
        let removed=self.entries.read().unwrap().iter().filter(|e|paths.iter().any(|p|Path::new(&e.path).starts_with(p))).map(|e|e.path.clone()).collect::<Vec<_>>();
        let fresh=fresh.into_values().collect::<Vec<_>>();
        if let Err(e)=self.persist(&fresh,&removed,false){self.error(e);}
        self.merge(&fresh,&paths);let mut s=self.status.lock().unwrap();s.count=self.entries.read().unwrap().len();s.generation+=1;
    }
    pub fn spawn(self:Arc<Self>,rx:mpsc::Receiver<()>) {
        self.status.lock().unwrap().scanning=true;
        std::thread::spawn(move|| {
            if let Err(error)=self.load_cached(){self.error(format!("缓存索引加载失败：{error}"));}
            let (event_tx,event_rx)=mpsc::channel();
            let mut watcher=None;
            let mut watch_retry=Instant::now()-Duration::from_secs(31);
            let mut watched:Vec<PathBuf>=vec![];let mut last_reconcile=Instant::now()-Duration::from_secs(301);
            loop {
                let requested=rx.try_iter().count()>0;
                let retry=watcher.is_none() && watch_retry.elapsed()>Duration::from_secs(30);
                if requested || retry || last_reconcile.elapsed()>Duration::from_secs(300) {
                    self.cache.lock().unwrap().clear();self.scan();last_reconcile=Instant::now();
                    if watcher.is_none(){watch_retry=Instant::now();let tx=event_tx.clone();match notify::recommended_watcher(move|res|{let _=tx.send(res);}){Ok(w)=>watcher=Some(w),Err(e)=>self.error(format!("目录监听不可用，已启用补偿扫描：{e}"))}}
                    let mut failed=false;
                    if let Some(w)=watcher.as_mut(){for p in &watched {let _=w.unwatch(p);}watched=self.roots.read().unwrap().clone();for p in &watched {if let Err(e)=w.watch(p,RecursiveMode::Recursive){failed=true;self.error(format!("目录监听失败：{e}"));}}}
                    if failed {watcher=None;watch_retry=Instant::now();}
                }
                let mut paths=HashSet::new();let mut rescan=false;
                while let Ok(event)=event_rx.try_recv(){match event {
                    Ok(event)=> {if event.need_rescan(){rescan=true;} if !matches!(event.kind,notify::EventKind::Access(_)){paths.extend(event.paths);}},
                    Err(_)=>{rescan=true;watcher=None;watch_retry=Instant::now()-Duration::from_secs(31);}
                }}
                if rescan {self.scan();} else if !paths.is_empty() {self.update(paths);}
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }
}
impl SearchProvider for Index {
    fn search(&self,q:&Query)->Results {
        let tokens=q.query.to_lowercase().split_whitespace().map(str::to_owned).collect::<Vec<_>>();
        let filter=q.filter.to_lowercase();let ext=q.extension.trim_start_matches('.').to_lowercase();
        let roots=self.roots.read().unwrap();let entries=self.entries.read().unwrap();
        let scope=q.root.as_deref().map(Path::new);let exact=q.query.to_lowercase();
        let mut matched=entries.iter().filter(|e| {
            let p=Path::new(&e.path);
            (if q.kind=="directory" {e.is_dir} else {!e.is_dir && !temporary_name(&e.name)}) && roots.iter().any(|r|within(p,r)) && scope.is_none_or(|r|if q.recursive{within(p,r)}else{Path::new(&e.parent)==r}) &&
            tokens.iter().all(|t|e.searchable.contains(t)) && e.searchable.contains(&filter) && (ext.is_empty()||e.extension==ext) && q.after.is_none_or(|a|e.modified>=a) && q.before.is_none_or(|b|e.modified<=b)
        }).map(|e| {
            let name=e.searchable.rsplit(['\\','/']).next().unwrap_or("");
            let rank=if name==exact{0}else if !exact.is_empty()&&name.starts_with(&exact){1}else{2};(rank,e)
        }).collect::<Vec<_>>();
        let total=matched.len();
        let compare=|a:&(u8,&Entry),b:&(u8,&Entry)|a.0.cmp(&b.0).then_with(||a.1.sort_key.cmp(&b.1.sort_key)).then_with(||a.1.path.cmp(&b.1.path));
        let end=q.offset.saturating_add(q.limit.clamp(1,200)).min(total);
        if end<total {matched.select_nth_unstable_by(end,compare);matched.truncate(end);}
        matched.sort_unstable_by(compare);
        Results{total,items:matched.into_iter().skip(q.offset).map(|(_,e)|e.clone()).collect()}
    }
}
