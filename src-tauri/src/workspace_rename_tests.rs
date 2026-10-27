use super::*;
use crate::index::{Entry, Query, SearchProvider};
use std::{fs, os::windows::fs::OpenOptionsExt};

struct Workspace {index:Arc<Index>,root:PathBuf,_temp:tempfile::TempDir}
impl Workspace {
    fn new()->Self{
        let base=Path::new(env!("CARGO_MANIFEST_DIR")).join("target/workspace-rename-checks");fs::create_dir_all(&base).unwrap();
        let temp=tempfile::Builder::new().prefix("check-").tempdir_in(base).unwrap();let root=temp.path().join("work");fs::create_dir(&root).unwrap();
        let root=plain(&root.canonicalize().unwrap()).unwrap();let (index,_)=Index::open(temp.path()).unwrap();init(&index).unwrap();index.configure(&[root.to_string_lossy().into_owned()]);Self{index,root,_temp:temp}
    }
    fn write(&self,name:&str,bytes:&[u8])->PathBuf{let path=self.root.join(name);fs::write(&path,bytes).unwrap();path}
    fn plan(&self,path:&Path,name:&str)->Record{preview(&self.index,path.to_str().unwrap(),name,path.is_dir(),false).unwrap()}
    fn seed_index(&self){*self.index.entries.write().unwrap()=walkdir::WalkDir::new(&self.root).into_iter().map(|e|e.unwrap().path().canonicalize().unwrap()).filter_map(|p|Entry::from_path(&p)).collect();}
}

#[test]
fn names_reject_paths_devices_invisible_characters_and_excess_length(){
    for name in ["",".","..","../escape.txt","folder/name.txt",r"C:\escape.txt","file:stream","CON.txt","con .txt","COM¹.pdf","LPT9","NUL","CONIN$","tail.","tail ","line\n.txt","a\u{202e}txt","a\u{feff}.txt"]{assert!(validate_name(name).is_err(),"{name:?}");}
    assert!(validate_name(&"界".repeat(256)).is_err());
    for name in ["合同 2026.txt","normal.tar.gz","COM10.txt",".gitignore"]{validate_name(name).unwrap();}
    assert!(!affects(r"D:\work\old-other\file.txt",r"D:\work\old",r"D:\work\new"));
    assert!(affects(r"\\?\D:\WORK\old\child.txt",r"D:\work\old",r"D:\work\new"));
}

#[test]
fn file_rename_preserves_bytes_updates_index_and_undo_survives_reload(){
    let w=Workspace::new();let original=w.write("原件.txt",b"synthetic contents, never business data");w.seed_index();
    let mut r=w.plan(&original,"新名称.txt");assert!(original.exists());assert!(!Path::new(&r.target).exists());
    execute(&w.index,&mut r,false,||Ok(())).unwrap();assert_eq!(r.status,"done");assert!(!original.exists());assert_eq!(fs::read(&r.target).unwrap(),b"synthetic contents, never business data");
    let results=w.index.search(&Query{query:"新名称".into(),limit:10,..Default::default()});assert_eq!(results.items.len(),1);assert!(results.items[0].path.ends_with("新名称.txt"));
    let mut saved=load(&w.index,&r.id).unwrap();execute(&w.index,&mut saved,true,||Ok(())).unwrap();assert_eq!(saved.status,"undone");assert!(original.exists());assert!(!Path::new(&r.target).exists());
}

#[test]
fn directory_rename_preserves_descendants_and_updates_cached_navigation(){
    let w=Workspace::new();let original=w.root.join("before");fs::create_dir_all(original.join("child/deep")).unwrap();fs::write(original.join("child/deep/data.txt"),b"nested synthetic content").unwrap();w.seed_index();
    assert_eq!(w.index.dirs(w.root.to_str().unwrap()).unwrap()[0].name,"before");
    let mut r=w.plan(&original,"after");execute(&w.index,&mut r,false,||Ok(())).unwrap();
    assert_eq!(fs::read(Path::new(&r.target).join("child/deep/data.txt")).unwrap(),b"nested synthetic content");assert_eq!(w.index.dirs(w.root.to_str().unwrap()).unwrap()[0].name,"after");
    assert!(w.index.entries.read().unwrap().iter().all(|e|!e.path.contains("\\before")));
    execute(&w.index,&mut r,true,||Ok(())).unwrap();assert!(original.join("child/deep/data.txt").exists());
}

#[test]
fn conflicts_at_preview_or_after_preview_never_replace_a_target(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let target=w.write("after.txt",b"keep target");
    assert!(preview(&w.index,original.to_str().unwrap(),"after.txt",false,false).is_err());
    assert!(preview(&w.index,original.to_str().unwrap(),"BEFORE.txt",false,false).is_err());
    let mut r=w.plan(&original,"next.txt");w.write("next.txt",b"created after preview");assert!(execute(&w.index,&mut r,false,||Ok(())).is_err());
    assert_eq!(fs::read(&original).unwrap(),b"source");assert_eq!(fs::read(&target).unwrap(),b"keep target");assert_eq!(fs::read(&r.target).unwrap(),b"created after preview");
}

#[test]
fn native_no_replace_protects_against_a_target_created_after_the_final_check(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let mut r=w.plan(&original,"after.txt");let target=PathBuf::from(&r.target);
    assert!(execute(&w.index,&mut r,false,||{fs::write(&target,b"race winner").unwrap();Ok(())}).is_err());
    assert_eq!(fs::read(&original).unwrap(),b"source");assert_eq!(fs::read(&target).unwrap(),b"race winner");
}

#[test]
fn replaced_or_changed_sources_and_changed_directory_children_are_rejected(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let mut r=w.plan(&original,"after.txt");
    fs::rename(&original,w.root.join("saved.txt")).unwrap();w.write("before.txt",b"source");assert!(execute(&w.index,&mut r,false,||Ok(())).is_err());assert!(original.exists());
    let directory=w.root.join("directory");fs::create_dir(&directory).unwrap();fs::write(directory.join("child.txt"),b"old").unwrap();let mut r=w.plan(&directory,"changed");
    fs::write(directory.join("child.txt"),b"new and longer").unwrap();assert!(execute(&w.index,&mut r,false,||Ok(())).is_err());assert!(directory.exists());
}

#[test]
fn undo_refuses_occupied_old_name_and_edited_files(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let mut r=w.plan(&original,"after.txt");execute(&w.index,&mut r,false,||Ok(())).unwrap();
    w.write("before.txt",b"keep new occupant");assert!(execute(&w.index,&mut r,true,||Ok(())).is_err());assert_eq!(fs::read(&original).unwrap(),b"keep new occupant");
    fs::remove_file(&original).unwrap();fs::write(&r.target,b"edited after rename").unwrap();assert!(execute(&w.index,&mut r,true,||Ok(())).is_err());assert!(!original.exists());assert_eq!(fs::read(&r.target).unwrap(),b"edited after rename");
}

#[test]
fn extension_changes_require_explicit_permission_and_long_paths_are_rejected(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");
    assert!(preview(&w.index,original.to_str().unwrap(),"after.pdf",false,false).is_err());
    assert!(preview(&w.index,original.to_str().unwrap(),"after.pdf",false,true).unwrap().extension_changed);
    assert!(preview(&w.index,original.to_str().unwrap(),&format!("{}.txt","a".repeat(240)),false,false).is_err());assert!(original.exists());
}

#[test]
fn locks_grants_roots_and_junctions_are_enforced(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");
    let occupied=fs::OpenOptions::new().read(true).share_mode(1).open(&original).unwrap();assert!(preview(&w.index,original.to_str().unwrap(),"after.txt",false,false).is_err());drop(occupied);
    let mut r=w.plan(&original,"after.txt");w.index.configure(&[]);assert!(execute(&w.index,&mut r,false,||Ok(())).is_err());assert!(original.exists());
    w.index.configure(&[w.root.to_string_lossy().into_owned()]);assert!(preview(&w.index,w.root.to_str().unwrap(),"renamed-root",true,false).is_err());
    let directory=w.root.join("actual");fs::create_dir(&directory).unwrap();fs::write(directory.join("file.txt"),b"outside through junction").unwrap();let link=w.root.join("junction");
    let status=std::process::Command::new("cmd.exe").args(["/c","mklink","/J"]).arg(&link).arg(&directory).output().unwrap();assert!(status.status.success(),"{status:?}");
    assert!(preview(&w.index,link.join("file.txt").to_str().unwrap(),"renamed.txt",false,false).is_err());assert!(directory.join("file.txt").exists());
}

#[test]
fn persisted_intent_recognizes_unstarted_operations_and_refuses_ambiguous_moved_objects(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let mut r=w.plan(&original,"after.txt");r.status="applying".into();save(&w.index,&r).unwrap();
    recover(&w.index,&mut r).unwrap();assert_eq!(r.status,"failed");assert!(original.exists());
    r.status="applying".into();save(&w.index,&r).unwrap();{let file=open_source(&original,true).unwrap();move_handle(&file,Path::new(&r.target)).unwrap();}
    fs::write(&r.target,b"changed after interruption").unwrap();
    let mut saved=load(&w.index,&r.id).unwrap();assert!(recover(&w.index,&mut saved).is_err());assert_eq!(saved.status,"applying");assert!(!original.exists());assert_eq!(fs::read(&r.target).unwrap(),b"changed after interruption");
}

#[test]
fn windows_change_time_detects_edits_even_if_size_and_modified_time_are_restored(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let modified=fs::metadata(&original).unwrap().modified().unwrap();let mut r=w.plan(&original,"after.txt");
    fs::write(&original,b"edited").unwrap();fs::File::options().write(true).open(&original).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
    assert!(execute(&w.index,&mut r,false,||Ok(())).is_err());assert_eq!(fs::read(&original).unwrap(),b"edited");assert!(!Path::new(&r.target).exists());
}

#[test]
fn a_failed_precommit_never_moves_the_file(){
    let w=Workspace::new();let original=w.write("before.txt",b"source");let mut r=w.plan(&original,"after.txt");
    assert!(execute(&w.index,&mut r,false,||Err("synthetic journal/invalidation failure".into())).is_err());assert!(original.exists());assert!(!Path::new(&r.target).exists());
}

#[test]
fn directory_changes_during_confirmation_stop_before_the_native_move(){
    let w=Workspace::new();let original=w.root.join("before");fs::create_dir(&original).unwrap();let mut r=w.plan(&original,"after");
    assert!(execute(&w.index,&mut r,false,||{fs::write(original.join("arrived.txt"),b"new child").unwrap();Ok(())}).is_err());
    assert!(original.join("arrived.txt").exists());assert!(!Path::new(&r.target).exists());
}

#[test]
fn directory_rename_checks_the_longest_descendant_target_path(){
    let w=Workspace::new();let original=w.root.join("a");fs::create_dir(&original).unwrap();let child=original.join(format!("{}.txt","c".repeat(80)));fs::write(&child,b"synthetic").unwrap();
    let name="n".repeat(80);assert!(w.root.join(&name).to_string_lossy().encode_utf16().count()<240);
    assert!(preview(&w.index,original.to_str().unwrap(),&name,true,false).is_err());assert!(child.exists());
}
