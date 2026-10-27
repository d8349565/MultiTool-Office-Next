use std::{fs::{File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf, Component}};

pub fn relative_path(raw:&str)->Result<PathBuf,String>{
    if raw.is_empty()||raw.len()>500{return Err("文件名为空或过长".into());}
    let mut path=PathBuf::new();
    for part in raw.split(['/', '\\']) {
        let stem=part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()||part.starts_with('.')||part.ends_with(['.',' '])||part.chars().any(|c|c.is_control()||matches!(c,'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{feff}')||"<>:\"|?*".contains(c))||["CON","PRN","AUX","NUL","CLOCK$","CONIN$","CONOUT$"].contains(&stem.as_str())||((stem.starts_with("COM")||stem.starts_with("LPT"))&&(stem[3..].parse::<u8>().is_ok_and(|n|(1..=9).contains(&n))||["¹","²","³"].contains(&&stem[3..]))) {return Err("仅允许目录内的普通相对文件名，不支持隐藏文件、路径跳转、设备名或附加数据流".into());}
        path.push(part);
    }
    Ok(path)
}
pub fn extension(path:&Path)->Result<String,String>{
    let ext=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["txt","md","csv","json","html","docx","xlsx","pptx","pdf"].contains(&ext.as_str()){return Err("只支持 TXT、MD、CSV、JSON、HTML、DOCX、XLSX、PPTX 及 PDF；PDF 仅支持创建，不读取程序、宏或凭据文件".into());}
    let name=path.file_name().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
    if ["credential","password","secret","api-key","api_key","id_rsa"].iter().any(|s|name.contains(s)){return Err("不允许助理读取凭据或密钥类文件".into());}
    Ok(ext)
}
pub(crate) fn root_path(path:&Path)->Result<(),String>{
    if !path.is_absolute()||path.components().count()<3{return Err("请选择一个本地专用文件夹，不能选择磁盘根目录或网络路径".into());}
    #[cfg(windows)] if !matches!(path.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),std::path::Prefix::Disk(_))){return Err("不允许网络、设备或特殊路径".into());}
    for part in path.components(){if let Component::Normal(part)=part{let part=part.to_string_lossy().to_ascii_lowercase();if part.chars().any(|c|c.is_control()||matches!(c,'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{feff}')){return Err("目录名称含不可见控制字符，不能安全授权".into());}if part.starts_with('.')||["windows","program files","program files (x86)","programdata","appdata","$recycle.bin","system volume information"].contains(&part.as_str()){return Err("不能授权系统、应用、隐藏或凭据目录；请新建一个专用文件夹".into());}}}
    if path.file_name().is_some_and(|p|p.to_string_lossy().eq_ignore_ascii_case("users"))||std::env::var_os("USERPROFILE").is_some_and(|p|Path::new(&p).to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy())){return Err("不能授权整个个人目录，请选择其下的专用文件夹".into());}
    Ok(())
}

pub struct Directory {pub path:PathBuf,pub identity:String,_locks:Vec<File>}
pub struct SourceFile {file:File,version:(u64,std::time::SystemTime),_locks:Vec<File>}
impl SourceFile{pub fn metadata(&self)->std::io::Result<std::fs::Metadata>{self.file.metadata()}}
fn file_version(file:&File)->Result<(u64,std::time::SystemTime),String>{
    let metadata=file.metadata().map_err(|_|"无法读取文件信息，请重新选择文件")?;
    Ok((metadata.len(),metadata.modified().map_err(|_|"无法核对文件修改时间，请保存文件后重试")?))
}
fn read_error(error:std::io::Error)->String{
    match error.raw_os_error(){
        Some(32|33)=>"文件被其他程序独占，请保存并关闭该文件后重试".into(),
        _=>match error.kind(){
            std::io::ErrorKind::NotFound=>"文件不存在或已移动，请先用 workspace_list_files 列出助理目录，按实际文件名（含扩展名）重试".into(),
            std::io::ErrorKind::PermissionDenied=>"Windows 拒绝读取此文件，请检查文件权限；助理目录授权不能替代系统权限".into(),
            _=>format!("无法打开文件，请检查文件状态后重试（系统错误：{error}）"),
        },
    }
}
#[cfg(windows)]
pub(crate) fn information(file:&File)->Result<(PathBuf,String,u32,u32),String>{
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION,GetFileInformationByHandle,GetFinalPathNameByHandleW,FILE_NAME_NORMALIZED}};
    let handle=HANDLE(file.as_raw_handle());let mut info=BY_HANDLE_FILE_INFORMATION::default();
    unsafe{GetFileInformationByHandle(handle,&mut info)}.map_err(|_|"无法验证文件身份")?;
    let mut buffer=vec![0u16;32768];let n=unsafe{GetFinalPathNameByHandleW(handle,&mut buffer,FILE_NAME_NORMALIZED)} as usize;
    if n==0||n>=buffer.len(){return Err("无法验证文件的最终物理路径".into());}
    let path=String::from_utf16(&buffer[..n]).map_err(|_|"文件路径编码无效")?;
    let path=path.strip_prefix("\\\\?\\").ok_or("不支持的文件路径")?;
    if path.starts_with("UNC\\"){return Err("不允许访问网络目录".into());}
    Ok((PathBuf::from(path),format!("{}:{}:{}",info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow),info.dwFileAttributes,info.nNumberOfLinks))
}
#[cfg(windows)]
fn lock_directory(path:&Path)->Result<File,String>{
    use std::os::windows::fs::OpenOptionsExt;
    let file=OpenOptions::new().access_mode(0x80).share_mode(1).custom_flags(0x02000000|0x00200000).open(path).map_err(|_|"目录无法安全锁定，可能被占用、已经移动或没有权限")?;
    let (_,_,attributes,_)=information(&file)?;
    if attributes&0x400!=0||attributes&0x10==0{return Err("工作目录不能包含符号链接、目录联接或重解析点".into());}Ok(file)
}
impl Directory{
    pub fn relative_input(&self,raw:&str)->Result<PathBuf,String>{
        let input=Path::new(raw);
        if !input.is_absolute(){return relative_path(raw);}
        let mut parts=input.components();
        for root in self.path.components(){
            if !parts.next().is_some_and(|part|part.as_os_str().to_string_lossy().eq_ignore_ascii_case(&root.as_os_str().to_string_lossy())){return Err("路径不在当前授权的助理工作目录内；请先列出助理目录文件，不要改用业务索引搜索".into());}
        }
        let relative=parts.as_path();
        if relative.as_os_str().is_empty(){return Ok(PathBuf::new());}
        relative_path(&relative.to_string_lossy())
    }
    pub fn lock(path:&Path)->Result<Self,String>{
        root_path(path)?;
        #[cfg(windows)] {
            let mut prefix=PathBuf::new();let mut locks=vec![];
            for component in path.components(){prefix.push(component.as_os_str());if matches!(component,Component::RootDir|Component::Normal(_)){locks.push(lock_directory(&prefix)?);}}
            let (path,identity,_,_)=information(locks.last().ok_or("目录无效")?)?;root_path(&path)?;
            Ok(Self{path,identity,_locks:locks})
        }
        #[cfg(not(windows))] {Err("此目录权限边界目前仅支持 Windows 桌面版".into())}
    }
    pub fn read_file(&self,relative:&str)->Result<SourceFile,String>{
        let relative=self.relative_input(relative)?;extension(&relative)?;
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            let mut folder=self.path.clone();let mut locks=vec![];
            if let Some(parent)=relative.parent(){for component in parent.components(){folder.push(component.as_os_str());locks.push(lock_directory(&folder)?);}}
            let file=OpenOptions::new().read(true).share_mode(3).custom_flags(0x00200000).open(self.path.join(relative)).map_err(read_error)?;
            let (final_path,_,attributes,links)=information(&file)?;
            if !final_path.starts_with(&self.path)||attributes&0x410!=0||links!=1{return Err("拒绝目录之外的文件、链接、硬链接或重解析点".into());}
            // 将父目录锁与读取句柄的生命周期绑定，避免校验后被替换。
            // 允许 Office 保持编辑句柄，仍拒绝删除共享；确认前后核对版本，读取使用同一已验证句柄。
            Ok(SourceFile{version:file_version(&file)?,file,_locks:locks})
        }
        #[cfg(not(windows))] {Err("此功能仅支持 Windows 桌面版".into())}
    }
    pub fn create(&self,name:&str,bytes:&[u8])->Result<PathBuf,String>{
        let relative=relative_path(name)?;
        if relative.components().count()!=1||bytes.len()>8_000_000{return Err("输出只能新建在工作目录根部，且不超过 8 MB".into());}
        extension(&relative)?;let path=self.path.join(relative);
        let mut options=OpenOptions::new();options.write(true).create_new(true);
        #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(0).custom_flags(0x00200000);}
        let mut file=options.open(&path).map_err(|_|"文件名已存在或没有写入权限，请换一个文件名；已有文件不会被覆盖")?;
        #[cfg(windows)] {let (actual,_,attributes,links)=information(&file)?;if !actual.starts_with(&self.path)||attributes&0x410!=0||links!=1{return Err("目标文件未通过安全校验".into());}}
        // ponytail: 失败时保留未完成的新文件，避免关闭句柄后按路径删除造成竞态；由用户手动处理。
        if file.write_all(bytes).and_then(|_|file.sync_all()).is_err(){return Err("新文件写入中断，目录中可能保留不完整文件；请另取名称或手动处理。已有文件未被覆盖或删除。".into());}Ok(path)
    }
}
pub fn bounded_read(mut source:SourceFile)->Result<Vec<u8>,String>{
    let file=&mut source.file;
    if file_version(file)?!=source.version{return Err("文件在等待确认期间发生变化，请保存后重新确认读取".into());}
    if source.version.0>8_000_000{return Err("文件超过 8 MB 读取上限，请拆分后重试".into());}
    let mut data=vec![];Read::by_ref(file).take(8_000_001).read_to_end(&mut data).map_err(|_|"文件读取失败")?;
    if data.len()>8_000_000{return Err("文件超过读取上限".into());}
    if file_version(file)?!=source.version{return Err("文件在读取过程中发生变化，未发送正文；请保存并停止编辑后重试".into());}Ok(data)
}

#[cfg(all(test,windows))]
mod tests{
    use super::*;
    #[test]
    fn absolute_inputs_stay_inside_the_authorized_directory(){
        let directory=Directory{path:PathBuf::from(r"D:\multi"),identity:String::new(),_locks:vec![]};
        assert_eq!(directory.relative_input(r"d:\MULTI\资料\表格.xlsx").unwrap(),PathBuf::from(r"资料\表格.xlsx"));
        assert_eq!(directory.relative_input(r"D:\multi").unwrap(),PathBuf::new());
        for path in [r"D:\multi-other\表格.xlsx",r"D:\multi\..\表格.xlsx",r"E:\multi\表格.xlsx",r"D:\multi\表格.xlsx:stream"]{assert!(directory.relative_input(path).is_err());}
    }
    fn folder()->tempfile::TempDir{
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("target/assistant-fs-audit");std::fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new().prefix("audit-").tempdir_in(root).unwrap()
    }
    #[test]
    fn a_saved_office_file_can_be_read_while_an_editor_holds_it(){
        use std::os::windows::fs::OpenOptionsExt;
        let folder=folder();let directory=Directory::lock(folder.path()).unwrap();let path=directory.create("audit.txt",b"synthetic content").unwrap();
        let _editor=OpenOptions::new().read(true).write(true).share_mode(3).open(&path).unwrap();
        assert_eq!(bounded_read(directory.read_file("audit.txt").unwrap()).unwrap(),b"synthetic content");
    }
    #[test]
    fn changed_files_are_rejected_after_confirmation(){
        let folder=folder();let directory=Directory::lock(folder.path()).unwrap();let path=directory.create("audit.txt",b"old").unwrap();
        let source=directory.read_file("audit.txt").unwrap();std::fs::write(path,b"changed synthetic content").unwrap();
        assert!(bounded_read(source).unwrap_err().contains("变化"));
    }
    #[test]
    fn create_never_overwrites_an_existing_file(){
        let folder=folder();let directory=Directory::lock(folder.path()).unwrap();directory.create("keep.txt",b"original").unwrap();
        assert!(directory.create("keep.txt",b"replacement").is_err());assert_eq!(bounded_read(directory.read_file("keep.txt").unwrap()).unwrap(),b"original");
    }
}
