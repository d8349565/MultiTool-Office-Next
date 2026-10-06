use std::{collections::{BTreeMap, BTreeSet}, path::PathBuf};
use serde_json::{json, Value};

pub fn launcher_open_target(raw:&str)->Result<String,String>{
    match crate::settings::launcher_target(raw)? {
        crate::settings::LauncherTarget::Web(url)=>Ok(url),
        crate::settings::LauncherTarget::Local(path)=>{
            if !path.exists(){return Err("工具目标已不存在".into());}
            Ok(path.to_string_lossy().into_owned())
        }
    }
}
pub fn launch(raw:&str)->Result<(),String>{
    let target=launcher_open_target(raw)?;
    open::that_detached(target).map_err(|e|e.to_string())
}
fn group_paths(paths:Vec<PathBuf>)->Result<(Vec<PathBuf>,BTreeMap<PathBuf,Vec<PathBuf>>),String>{
    if paths.is_empty() || paths.len()>200{return Err("请选择 1 至 200 个文件进行定位".into());}
    let mut groups=BTreeMap::<PathBuf,Vec<PathBuf>>::new();
    let mut roots=vec![];
    for path in paths.into_iter().collect::<BTreeSet<_>>() {
        if let Some(parent)=path.parent(){groups.entry(parent.to_path_buf()).or_default().push(path);}else{roots.push(path);}
    }
    Ok((roots,groups))
}

pub fn reveal(paths:Vec<PathBuf>)->Result<Value,String>{
    let (roots,groups)=group_paths(paths)?;
    // A dedicated thread owns the COM apartment and all PIDLs throughout each selection.
    std::thread::spawn(move||{
        let mut results=vec![];
        for root in roots {
            let result=open::that_detached(&root).map_err(|e|e.to_string());
            results.push(match result{Ok(())=>json!({"directory":root,"paths":[root],"status":"selection_requested","action":"open_root"}),Err(e)=>json!({"directory":root,"paths":[root],"status":"failed","error":e})});
        }
        for (parent,paths) in groups {
            #[cfg(windows)] let result=windows::select(&parent,&paths);
            #[cfg(not(windows))] let result=open::that(&parent).map_err(|e|e.to_string());
            results.push(match result{Ok(())=>json!({"directory":parent,"paths":paths,"status":"selection_requested"}),Err(e)=>json!({"directory":parent,"paths":paths,"status":"failed","error":e})});
        }
        json!({"groups":results,"note":"根目录直接打开，其余路径按目录一次提交全部文件选择；系统返回成功表示已接受请求，不代表已验证屏幕显示。逐个文件的定位链接始终可用。"})
    }).join().map_err(|_|"资源管理器定位线程失败".into())
}

#[cfg(windows)] mod windows {
    use std::{ffi::c_void,os::windows::ffi::OsStrExt,path::{Path,PathBuf},ptr};
    // Windows SDK SHOpenFolderAndSelectItems / SHParseDisplayName signatures.
    #[link(name="ole32")] extern "system" {
        fn CoInitializeEx(reserved:*const c_void,flags:u32)->i32;
        fn CoUninitialize();
        fn CoTaskMemFree(memory:*mut c_void);
    }
    #[link(name="shell32")] extern "system" {
        fn SHParseDisplayName(name:*const u16,bind:*const c_void,pidl:*mut *mut c_void,attributes:u32,output:*mut u32)->i32;
        fn ILFindLastID(pidl:*const c_void)->*const c_void;
        fn SHOpenFolderAndSelectItems(folder:*const c_void,count:u32,children:*const *const c_void,flags:u32)->i32;
    }
    struct Apartment;
    impl Drop for Apartment{fn drop(&mut self){unsafe{CoUninitialize();}}}
    struct Pidl(*mut c_void);
    impl Drop for Pidl{fn drop(&mut self){unsafe{CoTaskMemFree(self.0);}}}
    fn parse(path:&Path)->Result<Pidl,String>{
        let text=path.to_string_lossy();
        let display=if let Some(rest)=text.strip_prefix("\\\\?\\UNC\\"){format!("\\\\{rest}")}else{text.strip_prefix("\\\\?\\").unwrap_or(&text).to_owned()};
        let wide=std::ffi::OsStr::new(&display).encode_wide().chain(Some(0)).collect::<Vec<_>>();let mut pidl=ptr::null_mut();
        let result=unsafe{SHParseDisplayName(wide.as_ptr(),ptr::null(),&mut pidl,0,ptr::null_mut())};
        if result<0 || pidl.is_null(){return Err(format!("无法解析定位路径（HRESULT {result:#x}）：{display}"));}Ok(Pidl(pidl))
    }
    pub fn select(parent:&Path,paths:&[PathBuf])->Result<(),String>{
        let hr=unsafe{CoInitializeEx(ptr::null(),2)};if hr<0{return Err(format!("无法初始化资源管理器接口：{hr:#x}"));}let _apartment=Apartment;
        let folder=parse(parent)?;let items=paths.iter().map(|p|parse(p)).collect::<Result<Vec<_>,_>>()?;
        let children=items.iter().map(|p|unsafe{ILFindLastID(p.0)}).collect::<Vec<_>>();
        let hr=unsafe{SHOpenFolderAndSelectItems(folder.0,children.len() as u32,children.as_ptr(),0)};
        if hr<0{Err(format!("资源管理器拒绝定位请求：{hr:#x}"))}else{Ok(())}
    }
}
