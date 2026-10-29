pub(crate) mod model;mod rules;mod store;pub(crate) mod worker;
pub(crate) mod assistant;
pub(crate) mod diagnostic_share;
#[cfg(test)]
#[path = "profile_tests.rs"]
mod profile_tests;
use crate::AppState;
use model::*;
pub use store::OcrStore;
use serde_json::{json,Value};
use std::{collections::{BTreeMap,HashSet},path::Path,sync::{Arc,atomic::{AtomicBool,Ordering}},time::Instant};
use tauri::Emitter;

#[tauri::command]pub async fn ocr_preview_sample(state:tauri::State<'_,Arc<AppState>>,path:String,page:u32)->Result<Value,String>{
    if !(1..=10000).contains(&page){return Err("预览页码无效".into());}
    let exe=state.ocr.exe.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let path=store::safe_file(Path::new(&path))?;
        worker::Worker::spawn(&exe)?.preview(&path.to_string_lossy(),page)
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]pub fn ocr_bootstrap(state:tauri::State<Arc<AppState>>)->OcrBootstrap{let d=state.ocr.data.lock().unwrap();let mut tasks:Vec<_>=d.tasks.values().cloned().collect();tasks.sort_by_key(|t|std::cmp::Reverse(t.created));OcrBootstrap{profiles:d.profiles.clone(),tasks,batches:d.batches.values().cloned().collect(),engine_ready:state.ocr.unavailable_reason.is_none()&&state.ocr.exe.exists(),jev_ready:crate::ai::key("jev").and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok(),unavailable_reason:state.ocr.unavailable_reason.clone()}}
#[tauri::command]pub fn ocr_save_profile(state:tauri::State<Arc<AppState>>,profile:OcrProfile)->Result<OcrProfile,String>{rules::validate(&profile)?;let mut d=state.ocr.data.lock().unwrap();let mut profiles=d.profiles.clone();if let Some(i)=profiles.iter().position(|p|p.id==profile.id){profiles[i]=profile.clone();}else{if profiles.len()>=100{return Err("最多保存 100 个配置".into());}profiles.push(profile.clone());}state.ocr.save_profiles(&profiles)?;d.profiles=profiles;Ok(profile)}
#[tauri::command]pub fn ocr_delete_profile(state:tauri::State<Arc<AppState>>,id:String)->Result<(),String>{let mut d=state.ocr.data.lock().unwrap();let profiles=d.profiles.iter().filter(|p|p.id!=id).cloned().collect::<Vec<_>>();state.ocr.save_profiles(&profiles)?;d.profiles=profiles;Ok(())}
#[tauri::command]pub fn ocr_export_profile(profile:OcrProfile,path:String)->Result<(),String>{rules::validate(&profile)?;if Path::new(&path).extension().and_then(|v|v.to_str())!=Some("json"){return Err("配置必须导出为 JSON".into());}use std::io::Write;let mut f=std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e|e.to_string())?;f.write_all(&serde_json::to_vec_pretty(&profile).map_err(|e|e.to_string())?).and_then(|_|f.sync_all()).map_err(|e|e.to_string())}
#[tauri::command]pub fn ocr_import_profiles(text:String)->Result<Vec<OcrProfile>,String>{
    if text.len()>500_000{return Err("配置文件过大".into());}
    if let Ok(p)=serde_json::from_str::<OcrProfile>(&text){rules::validate(&p)?;return Ok(vec![p]);}
    if let Ok(p)=serde_json::from_str::<Vec<OcrProfile>>(&text){for v in &p{rules::validate(v)?;}return Ok(p);}
    let yaml:Value=serde_yaml::from_str(&text).map_err(|e|format!("配置不是有效 JSON/YAML：{e}"))?;let templates=yaml["templates"].as_array().ok_or("YAML 必须包含 templates")?;let mut profiles=vec![];
    for t in templates{let strings=|v:&Value|v.as_array().map(|a|a.iter().filter_map(|v|v.as_str().map(str::to_owned)).collect()).unwrap_or_default();let mut p=OcrProfile{name:t["name"].as_str().unwrap_or("导入配置").into(),keywords:strings(&t["match_keywords"]),pages:format!("1-{}",t["scan_pages"].as_u64().unwrap_or(1)),filename_pattern:t["filename_pattern"].as_str().unwrap_or("{原文件名}").trim_end_matches(".pdf").into(),..Default::default()};
        for f in t["fields"].as_array().ok_or("模板缺少 fields")?{p.fields.push(OcrFieldDefinition{key:f["key"].as_str().unwrap_or("").into(),prompt:f["prompt"].as_str().or(f["jev_instructions"].as_str()).unwrap_or("").into(),multiple:f["multiple"].as_bool().unwrap_or(false),max_items:f["max_items"].as_u64().unwrap_or(5)as usize,separator:f["separator"].as_str().unwrap_or("、").into(),fallback:f["fallback_default"].as_str().unwrap_or("").into(),anchors:strings(&f["anchor_keywords"]),strip_prefixes:strings(&f["anchor_keywords"]),kind:if f["strategy"]=="regex_date"{"date"}else{"text"}.into(),..Default::default()});}rules::validate(&p)?;profiles.push(p);
    }Ok(profiles)
}
fn sanitize_field(f: &mut OcrFieldDefinition) {
    if f.kind == "date" {
        f.format=if f.format.trim().contains("中文"){"%Y年%m月%d日"}else{rules::canonical_date_format(&f.format).unwrap_or("%Y%m%d")}.into();
    }
}

fn editable_field_keys(profile:&OcrProfile,description:&str)->Vec<String>{
    let desc=description.chars().filter(|c|!c.is_whitespace()&&!"“”\"'".contains(*c)).collect::<String>();
    let all=["全部字段","所有字段","整个配置","整套配置","重新生成"].iter().any(|word|desc.contains(word));
    profile.fields.iter().filter(|f|{
        let protected=["保留","保持","不改","不要修改","不修改"].iter().any(|prefix|desc.contains(&format!("{prefix}{}",f.key)))
            ||["不变","保持不变","保持原样","无需修改","不修改"].iter().any(|suffix|desc.contains(&format!("{}{suffix}",f.key)));
        !protected&&(all||desc.contains(&f.key))
    }).map(|f|f.key.clone()).collect()
}

fn merge_profile(orig: OcrProfile, desc: &str, mut generated: OcrProfile) -> OcrProfile {
    for f in &mut generated.fields {
        sanitize_field(f);
    }
    if orig.fields.is_empty() {
        let mut res = generated;
        res.id = orig.id;
        res.regions = orig.regions;
        return res;
    }

    let mut merged = orig.clone();
    let editable=editable_field_keys(&orig,desc);
    let desc=desc.chars().filter(|c|!c.is_whitespace()&&!"“”\"'".contains(*c)).collect::<String>();

    // 基础配置信息：仅在用户明确提出修改要求时更新，否则锁定原有配置
    let wants_rename = desc.contains("改名") || desc.contains("更名") || desc.contains("配置名") || desc.contains("名称改为");
    if wants_rename && !generated.name.trim().is_empty() {
        merged.name = generated.name;
    }
    let wants_pattern_change = desc.contains("命名") || desc.contains("文件名");
    if wants_pattern_change && !generated.filename_pattern.trim().is_empty() {
        merged.filename_pattern = generated.filename_pattern;
    }
    if desc.contains("关键词"){merged.keywords=generated.keywords;}
    if desc.contains("页范围")||desc.contains("扫描页"){merged.pages=generated.pages;}
    if desc.to_ascii_lowercase().contains("dpi"){merged.dpi=generated.dpi;}
    if desc.contains("阈值"){merged.threshold=generated.threshold;}
    if desc.contains("附加标题")||desc.contains("内部标题"){merged.extra_titles=generated.extra_titles;}
    if desc.contains("排除词")||desc.contains("噪声词"){merged.noise_markers=generated.noise_markers;}
    if desc.contains("专有表头")||desc.contains("补充表头"){merged.extra_headers=generated.extra_headers;}

    // 字段智能增量合并
    let mut updated_fields = Vec::new();
    let mut handled_keys = HashSet::new();
    let mut deleted_keys = HashSet::new();

    // 1. 优先按原字段顺序保留并更新已有字段
    for orig_f in &orig.fields {
        let is_deleted = desc.contains(&format!("删除{}", orig_f.key))
            || desc.contains(&format!("去掉{}", orig_f.key))
            || desc.contains(&format!("移除{}", orig_f.key));
        if is_deleted {
            handled_keys.insert(orig_f.key.clone());
            deleted_keys.insert(orig_f.key.clone());
            continue;
        }

        if let Some(new_f) = generated.fields.iter().find(|f| f.key == orig_f.key && editable.contains(&f.key)) {
            updated_fields.push(new_f.clone());
        } else {
            updated_fields.push(orig_f.clone());
        }
        handled_keys.insert(orig_f.key.clone());
    }

    // 2. 追加大模型新增的全新字段
    for new_f in generated.fields {
        if !handled_keys.contains(&new_f.key) && (desc.contains(&new_f.key)||["新增","添加","增加"].iter().any(|word|desc.contains(word))) {
            updated_fields.push(new_f);
        }
    }

    merged.fields = updated_fields;
    merged.id = orig.id;
    merged.regions = orig.regions;
    if !deleted_keys.is_empty() {
        merged.regions.retain(|r| !r.field_key.as_ref().is_some_and(|key| deleted_keys.contains(key)));
        let previous_pattern = merged.filename_pattern.clone();
        for key in deleted_keys {
            merged.filename_pattern = merged.filename_pattern.replace(&format!("{{{key}}}"), "");
        }
        if merged.filename_pattern != previous_pattern {
            merged.filename_pattern = merged.filename_pattern.trim_matches(|c:char| c.is_whitespace() || c=='_' || c=='-').to_owned();
            if merged.filename_pattern.is_empty() { merged.filename_pattern = "{原文件名}".into(); }
        }
    }
    merged
}

#[tauri::command]pub async fn ocr_generate_profile(state:tauri::State<'_,Arc<AppState>>,description:String,profile:OcrProfile)->Result<OcrProfile,String>{
    rules::validate(&profile)?;if description.trim().is_empty()||description.len()>12000{return Err("请输入配置需求，最多 12000 字节".into());}
    let settings=state.settings.lock().unwrap().clone();let cancel=AtomicBool::new(false);
    let original=serde_json::to_value(&profile).map_err(|e|e.to_string())?;
    let editable=editable_field_keys(&profile,&description);
    let generated=crate::ai::generate_ocr_profile(&settings,&description,&original,&editable,&cancel).await?;
    if profile.fields.is_empty()&&generated.fields.is_empty(){return Err("AI 未生成提取字段，请写明需要提取哪些内容".into());}
    let merged=merge_profile(profile,&description,generated);
    rules::validate(&merged)?;
    if serde_json::to_value(&merged).map_err(|e|e.to_string())?==original{return Err("AI 未产生可应用的修改。请写明要调整的字段名称（例如：优化公司名称），或明确要求调整全部字段".into());}
    Ok(merged)
}
#[tauri::command]pub async fn ocr_import_files(state:tauri::State<'_,Arc<AppState>>,paths:Vec<String>)->Result<OcrImportResult,String>{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
    state.ocr.ensure_available()?;
    let mut files=vec![];let mut errors=vec![];let mut seen=HashSet::new();
    for path in paths{let p=Path::new(&path);let candidates:Vec<_>=if p.is_dir(){walkdir::WalkDir::new(p).follow_links(false).into_iter().filter_map(|e|match e{Ok(e)if e.file_type().is_file()&&store::supported(e.path())=>Some(e.path().to_path_buf()),Err(e)=>{errors.push(e.to_string());None},_=>None}).take(2001).collect()}else{vec![p.to_path_buf()]};
        for candidate in candidates{if files.len()>=2000{errors.push("每次最多导入 2000 个文件".into());break;}match store::safe_file(&candidate){Ok(p)=>{let s=p.to_string_lossy().into_owned();if seen.insert(s.to_lowercase()){files.push(s);}},Err(e)=>errors.push(format!("{}：{e}",candidate.display()))}}
    }let mut d=state.ocr.data.lock().unwrap();d.grants.extend(files.iter().cloned());Ok(OcrImportResult{files,errors})}).await.map_err(|e|e.to_string())?}
fn persist(state:&AppState,task:&OcrTask,app:&tauri::AppHandle,file_index:Option<usize>)->Result<(),String>{if let Some(i)=file_index{state.ocr.save_task_file(task,i)?;}else{state.ocr.save_task_header(task)?;}state.ocr.data.lock().unwrap().tasks.insert(task.id.clone(),task.clone());let _=app.emit("ocr-progress",json!({"id":task.id,"status":task.status}));Ok(())}
#[tauri::command]pub fn ocr_get_task(state:tauri::State<Arc<AppState>>,id:String)->Result<OcrTask,String>{state.ocr.data.lock().unwrap().tasks.get(&id).cloned().ok_or("任务不存在".into())}
fn validate_workflow(options:&mut OcrWorkflowOptions)->Result<(),String>{
    if !["none","txt","csv","json"].contains(&options.export_format.as_str())||!["review","preview","apply"].contains(&options.rename.as_str()){return Err("一键任务选项无效，请重新设置".into());}
    if options.rename=="apply"&&!options.rename_confirmed{return Err("自动改名前请先确认命名规则及冲突处理".into());}
    if options.export_format!="none"{
        let directory=Path::new(&options.export_directory);
        if !directory.is_absolute(){return Err("请先选择一键任务的导出文件夹".into());}
        let directory=directory.canonicalize().map_err(|e|format!("导出文件夹不可用：{e}"))?;
        if !directory.is_dir(){return Err("导出位置已不再是文件夹".into());}
        options.export_directory=directory.to_string_lossy().into_owned();
    }
    Ok(())
}
#[tauri::command]pub fn ocr_start_task(state:tauri::State<Arc<AppState>>,app:tauri::AppHandle,paths:Vec<String>,profile_id:String,use_jev:bool,retry_id:Option<String>,retry_file_ids:Option<Vec<String>>,workflow:Option<OcrWorkflowOptions>)->Result<String,String>{
    state.ocr.ensure_available()?;
    if !state.ocr.exe.exists(){return Err("OCR 引擎尚未打包，请运行 npm run ocr:build".into());}
    let mut d=state.ocr.data.lock().unwrap();if d.queue.len()>=20{return Err("排队任务过多".into());}
    let auto_match=profile_id=="auto";
    let profiles=if auto_match{
        let profiles=d.profiles.clone();
        if !profiles.iter().any(|p|p.keywords.iter().any(|k|!k.trim().is_empty())){return Err("已保存的配置中没有自动匹配关键词；配置名称、字段标签和附加标题不参与匹配。请填写关键词并保存，或手动选择配置".into());}
        profiles
    }else{vec![d.profiles.iter().find(|p|p.id==profile_id).ok_or("所选识别配置已删除，请重新选择")?.clone()]};
    for profile in &profiles{rules::validate(profile)?;}
    let selected_profile=if auto_match{None}else{profiles.first().cloned()};
    let workflow=if let Some(mut options)=workflow{validate_workflow(&mut options)?;OcrWorkflow{enabled:true,options,status:"pending".into(),..Default::default()}}else{OcrWorkflow::default()};
    let task=if let Some(id)=retry_id{
        let old=d.tasks.get(&id).ok_or("原任务不存在")?;
        if ["running","queued"].contains(&old.status.as_str()){return Err("该任务仍在执行".into());}
        let mut t=old.clone();
        t.id=uuid::Uuid::new_v4().to_string();
        t.created=now();
        t.status="queued".into();
        t.files.retain(|f|if let Some(ids)=&retry_file_ids{ids.contains(&f.id)}else{["failed","cancelled","interrupted"].contains(&f.status.as_str())});
        if t.files.iter().any(|f|f.status=="relocated"){return Err("文件位置已被工作区改名影响，请从新位置重新导入，不再使用旧任务路径".into());}
        t.profiles=profiles;
        t.auto_match=auto_match;
        t.workflow=workflow;
        t.cleared_file_ids.clear();
        t.use_jev=use_jev;
        for f in &mut t.files{
            f.status="queued".into();
            f.error.clear();
            f.lines.clear();
            f.fields.clear();
            f.fingerprint.clear();
            f.diagnostics=None;
            f.profile=selected_profile.clone();
            f.proposed_name.clear();
            f.reviewed=false;
            f.warning.clear();
            f.elapsed_ms=0;
            f.id=uuid::Uuid::new_v4().to_string();
        }
        t
    }else{
        let mut seen=HashSet::new();
        let mut files=vec![];
        for path in paths{
            if !d.grants.contains(&path){return Err("文件未由用户导入".into());}
            if seen.insert(path.to_lowercase()){
                files.push(OcrFileResult{
                    id:uuid::Uuid::new_v4().to_string(),
                    original_name:Path::new(&path).file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    path,
                    status:"queued".into(),
                    error:String::new(),
                    profile:selected_profile.clone(),
                    lines:vec![],
                    fields:BTreeMap::new(),
                    proposed_name:String::new(),
                    reviewed:false,
                    elapsed_ms:0,
                    warning:String::new(),
                    fingerprint:String::new(),
                    diagnostics:None
                });
            }
        }
        OcrTask{id:uuid::Uuid::new_v4().to_string(),created:now(),status:"queued".into(),use_jev,profiles,files,auto_match,workflow,cleared_file_ids:vec![]}
    };
    if task.files.is_empty()||task.files.len()>2000{return Err("请选择 1–2000 个文件，或没有失败项可重试".into());}
    if d.tasks.values().any(|t|["queued","running"].contains(&t.status.as_str())&&t.files.iter().any(|f|task.files.iter().any(|n|n.path.eq_ignore_ascii_case(&f.path)))){return Err("这些文件已有任务运行，请等待完成".into());}
    state.ocr.save_task(&task)?;let id=task.id.clone();state.ocr.cancels.lock().unwrap().insert(id.clone(),Arc::new(AtomicBool::new(false)));d.queue.push_back(id.clone());d.tasks.insert(id.clone(),task);let start=!d.running;if start{d.running=true;}drop(d);
    if start{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||run_queue(state,app));}Ok(id)
}
#[tauri::command]pub fn ocr_cancel_task(state:tauri::State<Arc<AppState>>,id:String)->Result<(),String>{let cancels=state.ocr.cancels.lock().unwrap();let c=cancels.get(&id).ok_or("任务已结束")?;c.store(true,Ordering::Relaxed);Ok(())}
#[tauri::command]pub fn ocr_delete_task(state:tauri::State<Arc<AppState>>,id:String)->Result<(),String>{
    let mut d=state.ocr.data.lock().unwrap();
    if let Some(t)=d.tasks.get(&id){if ["queued","running"].contains(&t.status.as_str()){return Err("任务仍在执行中，请先取消".into());}}else{return Err("任务不存在".into());}
    state.ocr.delete_task_files(&d.tasks[&id]);
    let _=state.ocr.delete_task_db(&id);
    d.tasks.remove(&id);state.ocr.cancels.lock().unwrap().remove(&id);Ok(())
}
#[tauri::command]pub fn ocr_clear_completed_tasks(state:tauri::State<Arc<AppState>>)->Result<usize,String>{
    let mut d=state.ocr.data.lock().unwrap();
    let to_delete:Vec<String>=d.tasks.iter().filter(|(_,t)|completed_task(t,&d.batches)).map(|(id,_)|id.clone()).collect();
    let count=to_delete.len();
    for id in &to_delete{
        state.ocr.delete_task_files(&d.tasks[id]);
        let _=state.ocr.delete_task_db(id);
        d.tasks.remove(id);state.ocr.cancels.lock().unwrap().remove(id);
    }
    Ok(count)
}
fn completed_file_ids(task:&OcrTask,batches:&BTreeMap<String,OcrRenameBatch>)->HashSet<String>{
    if ["queued","running"].contains(&task.status.as_str()){return HashSet::new();}
    let workflow=&task.workflow;
    if workflow.enabled&&workflow.options.export_format!="none"&&workflow.export_path.is_empty(){return HashSet::new();}
    let renamed=batches.values().filter(|b|b.task_id==task.id).flat_map(|b|b.items.iter().filter(|i|i.status=="done"&&i.error.is_empty()).map(|i|(i.file_id.as_str(),i.target.as_str()))).collect::<HashSet<_>>();
    task.files.iter().filter(|f|["ready","review"].contains(&f.status.as_str())&&f.error.is_empty()&&(f.status=="ready"&&f.warning.is_empty()||f.reviewed)&&(!workflow.enabled||workflow.options.rename=="review"||renamed.contains(&(f.id.as_str(),f.path.as_str())))).map(|f|f.id.clone()).collect()
}
fn completed_task(task:&OcrTask,batches:&BTreeMap<String,OcrRenameBatch>)->bool{
    task.status=="completed"&&(!task.workflow.enabled||task.workflow.status=="completed")&&!task.files.is_empty()&&completed_file_ids(task,batches).len()==task.files.len()
}
#[tauri::command]pub fn ocr_clear_completed_results(state:tauri::State<Arc<AppState>>,id:String,restore:Option<bool>)->Result<usize,String>{
    state.ocr.ensure_available()?;
    let mut d=state.ocr.data.lock().unwrap();
    let mut task=d.tasks.get(&id).cloned().ok_or("任务不存在")?;
    if ["queued","running"].contains(&task.status.as_str()){return Err("请在任务结束后清理已完成项".into());}
    let before=task.cleared_file_ids.len();
    if restore.unwrap_or(false){task.cleared_file_ids.clear();}else{
        let completed=completed_file_ids(&task,&d.batches);
        for file in &task.files{if completed.contains(&file.id)&&!task.cleared_file_ids.contains(&file.id){task.cleared_file_ids.push(file.id.clone());}}
    }
    let count=before.abs_diff(task.cleared_file_ids.len());
    if count>0{state.ocr.save_task_header(&task)?;d.tasks.insert(id,task);}
    Ok(count)
}
fn run_queue(state:Arc<AppState>,app:tauri::AppHandle){
    let mut engine=None;
    loop{let (mut task,cancel)={let mut d=state.ocr.data.lock().unwrap();let Some(id)=d.queue.pop_front()else{d.running=false;return;};(d.tasks[&id].clone(),state.ocr.cancels.lock().unwrap()[&id].clone())};task.status="running".into();let mut storage_error=persist(&state,&task,&app,None).err();
        for i in 0..task.files.len(){if storage_error.is_some(){break;}if !["queued","running"].contains(&task.files[i].status.as_str()){continue;}if cancel.load(Ordering::Relaxed){task.files[i].status="cancelled".into();if let Err(e)=persist(&state,&task,&app,Some(i)){storage_error=Some(e);break;}continue;}
            let started=Instant::now();task.files[i].status="running".into();if let Err(e)=persist(&state,&task,&app,Some(i)){storage_error=Some(e);break;}
            let mut logs=vec![format!("开始处理文件：{}",task.files[i].original_name)];
            let mut jev_log=OcrJevLog{enabled:task.use_jev,..Default::default()};
            let mut ocr_elapsed=0;
            let result=(||->Result<(),String>{
                task.files[i].fingerprint=store::fingerprint(Path::new(&task.files[i].path))?;
                if engine.is_none(){engine=Some(worker::Worker::spawn(&state.ocr.exe)?);}
                let ocr_start=Instant::now();
                if task.files[i].profile.is_none(){
                    let first=OcrProfile::default();let file=task.files[i].clone();
                    engine.as_mut().unwrap().recognize(&file,&first,&[],&cancel,|lines|{task.files[i].lines.extend(lines);Ok(())})?;
                    if cancel.load(Ordering::Relaxed){return Err("任务已取消".into());}
                    if store::fingerprint(Path::new(&task.files[i].path))?!=task.files[i].fingerprint{return Err("文件在识别期间被修改，请重新识别".into());}
                    let (matched,profile_match)=rules::diagnose_profile_match(&task.profiles,&task.files[i].lines);
                    task.files[i].profile=matched.cloned();
                    logs.push(profile_match.message.clone());
                    let match_message=profile_match.message.clone();
                    task.files[i].diagnostics=Some(OcrFileDiagnostics{
                        ocr_lines_count:task.files[i].lines.len(),ocr_elapsed_ms:ocr_start.elapsed().as_millis() as u64,
                        logs:logs.clone(),profile_match:Some(profile_match),..Default::default()
                    });
                    if task.files[i].profile.is_none(){
                        task.files[i].warning=format!("{match_message} 已保留首页文字，可在详情查看自动匹配诊断；尚未生成拟命名或自动改名。");
                        task.files[i].status="review".into();return Ok(());
                    }
                    logs.push(format!("自动匹配配置：{}（依据关键词计分，不代表模型置信度）",task.files[i].profile.as_ref().unwrap().name));
                    // 按实际配置重新识别，避免首页探测的 DPI、页范围或区域污染提取结果。
                    task.files[i].lines.clear();
                }
                let p=task.files[i].profile.clone().unwrap();if !p.regions.is_empty(){task.files[i].lines.clear();}let skip=task.files[i].lines.iter().map(|l|l.page).collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();let file=task.files[i].clone();engine.as_mut().unwrap().recognize(&file,&p,&skip,&cancel,|lines|{task.files[i].lines.extend(lines);if task.files[i].lines.len()>50000{return Err("单文件超过 50000 行，请缩小页范围".into());}Ok(())})?;
                ocr_elapsed=ocr_start.elapsed().as_millis() as u64;
                logs.push(format!("OCR 文本识别完成，耗时 {}ms，提取到 {} 行文字",ocr_elapsed,task.files[i].lines.len()));
                if store::fingerprint(Path::new(&task.files[i].path))?!=task.files[i].fingerprint{return Err("文件在识别期间被修改，请重新识别".into());}
                let mut response=None;let mut plan=None;
                if task.use_jev&&!p.fields.is_empty(){
                    let jev_start=Instant::now();
                    match rules::jev_body(&task.files[i].lines,&p){
                        Ok(built)=>{
                            logs.push(format!("构建 Jev 请求（OCR 共 {} 行，按字段筛选后 {} 个脱敏候选，{} 个问询项）",task.files[i].lines.len(),built.masked.len(),built.questions.len()));
                            jev_log.candidates=built.masked.iter().map(|(idx,safe)|OcrJevCandidateLog{id:rules::opaque(*idx),original_line_index:*idx,original_text:task.files[i].lines[*idx].text.clone(),masked_text:safe.clone()}).collect();
                            jev_log.sent=!built.questions.is_empty();
                            if jev_log.sent{
                                let response_result=tauri::async_runtime::block_on(async {
                                    let mut answers=serde_json::Map::new();
                                    let batches = rules::jev_batches(&built.body);
                                    for batch_group in batches.chunks(4){
                                        let mut handles = Vec::with_capacity(batch_group.len());
                                        for batch in batch_group {
                                            let batch=batch.clone();
                                            let cancel_clone = cancel.clone();
                                            handles.push(tauri::async_runtime::spawn(async move {
                                                crate::ai::post("https://api.typesafe.ai/v1/systemone","jev",batch.clone(),&cancel_clone,crate::network::Feature::OcrJev).await
                                                    .map(|v| (batch, v))
                                            }));
                                        }
                                        for handle in handles {
                                            let (batch, v) = handle.await.map_err(|e| format!("Jev 任务执行异常: {e}"))??;
                                            let part=v["answers"].as_object().ok_or("Jev 返回缺少 answers")?;
                                            for (qid,question) in batch["questions"].as_object().unwrap(){
                                                let answer=part.get(qid).ok_or("Jev 返回缺少问题结果")?;
                                                if question["type"]=="choice"{
                                                    let choice=answer["choice"].as_str().ok_or("Jev 返回缺少候选 ID")?;
                                                    if question["criteria"].get(choice).is_none(){return Err("Jev 返回未提交的候选 ID".into());}
                                                }else{
                                                    let probability=answer["noul"].as_f64().ok_or("Jev 返回缺少 Noul 概率")?;
                                                    if !probability.is_finite()||!(0.0..=1.0).contains(&probability){return Err("Jev 返回无效 Noul 概率".into());}
                                                }
                                                answers.insert(qid.clone(),answer.clone());
                                            }
                                        }
                                    }
                                    Ok::<Value,String>(json!({"answers":answers}))
                                });
                                match response_result{
                                    Ok(v)=>{
                                        let jev_elapsed=jev_start.elapsed().as_millis() as u64;
                                        jev_log.success=true;jev_log.elapsed_ms=jev_elapsed;
                                        jev_log.raw_response=Some(v.clone());
                                        logs.push(format!("Jev 响应成功，耗时 {}ms",jev_elapsed));
                                        jev_log.questions=built.questions.iter().map(|(qid,fi,index)|{
                                            let f=&p.fields[*fi];
                                            let ans=&v["answers"][qid];
                                            let instructions=built.body["questions"][qid]["instructions"].as_str().unwrap_or("").to_owned();
                                            let (chosen_id,chosen_text,confidence)=if let Some(index)=index{
                                                let probability=ans["noul"].as_f64();
                                                (Some(rules::opaque(*index)),Some(format!("第 {} 行：{} → {}({:.0}%)",index+1,task.files[i].lines[*index].text,if probability.unwrap_or(0.0)>=0.5{"是"}else{"否"},probability.unwrap_or(0.0)*100.0)),probability)
                                            }else{
                                                let choice=ans["choice"].as_str().map(str::to_owned);
                                                let selected=choice.as_deref().and_then(|c|if c=="none"{Some("未找到 (none)".to_owned())}else{built.groups.get(&format!("{fi}:{c}")).and_then(|indices|indices.first()).map(|idx|format!("第 {} 行：{}",idx+1,task.files[i].lines[*idx].text))});
                                                (choice,selected,ans["confidence"].as_f64())
                                            };
                                            OcrJevQuestionLog{question_id:qid.clone(),field_key:f.key.clone(),instructions,chosen_id,chosen_text,confidence}
                                        }).collect();
                                        response=Some(v);
                                    },
                                    Err(e)=>{
                                        let jev_elapsed=jev_start.elapsed().as_millis() as u64;
                                        jev_log.success=false;jev_log.elapsed_ms=jev_elapsed;jev_log.error=Some(e.clone());
                                        task.files[i].warning=format!("Jev：{e}；已尝试配置的本地规则");
                                        logs.push(format!("Jev 调用失败（耗时 {}ms）：{}；降级使用本地规则",jev_elapsed,e));
                                    }
                                }
                            }
                            plan=Some(built);
                        },
                        Err(e)=>{
                            jev_log.error=Some(e.clone());task.files[i].warning=e.clone();
                            logs.push(format!("构建 Jev 请求失败：{}",e));
                        }
                    }
                }else if !task.use_jev{
                    logs.push("未启用 Jev，直接使用本地规则提取".into());
                }
                if cancel.load(Ordering::Relaxed){return Err("任务已取消".into());}
                let (fields,decisions)=rules::extract(&task.files[i].lines,&p,response.as_ref(),plan.as_ref(),&mut logs);
                let f=&mut task.files[i];
                f.fields=fields;
                f.proposed_name=rules::filename(&p,&f.fields,&f.path);
                f.status=if f.lines.is_empty()||f.fields.values().any(|v|v.review){"review"}else{"ready"}.into();
                logs.push(format!("拟命名：{}",f.proposed_name));
                logs.push(format!("处理完成，状态：{}",f.status));
                let profile_match=f.diagnostics.as_ref().and_then(|d|d.profile_match.clone());
                f.diagnostics=Some(OcrFileDiagnostics{ocr_lines_count:f.lines.len(),ocr_elapsed_ms:ocr_elapsed,jev:jev_log,decisions,logs,profile_match});
                Ok(())
            })();
            if let Err(e)=result{if should_reset_engine(&e){engine=None;}task.files[i].error=e;task.files[i].status=if cancel.load(Ordering::Relaxed){"cancelled"}else{"failed"}.into();}
            task.files[i].elapsed_ms=started.elapsed().as_millis()as u64;if let Err(e)=persist(&state,&task,&app,Some(i)){storage_error=Some(e);break;}
        }
        if storage_error.is_none()&&!cancel.load(Ordering::Relaxed)&&task.workflow.enabled{
            task.workflow.status="running".into();
            storage_error=persist(&state,&task,&app,None).err();
            if storage_error.is_none(){if let Err(error)=finish_workflow(&state,&mut task,&app,&cancel){task.workflow.error=error;task.workflow.status=if cancel.load(Ordering::Relaxed){"cancelled"}else{"failed"}.into();}}
        }
        if task.workflow.enabled&&cancel.load(Ordering::Relaxed){task.workflow.status="cancelled".into();}
        task.status=if storage_error.is_some()||task.workflow.status=="failed"{"failed"}else if cancel.load(Ordering::Relaxed){"cancelled"}else{"completed"}.into();if let Some(e)=storage_error{for f in &mut task.files{if f.status=="running"||f.status=="queued"{f.status="failed".into();f.error=format!("保存任务失败：{e}");}}let _=state.ocr.save_task(&task);}let _=persist(&state,&task,&app,None);let mut d=state.ocr.data.lock().unwrap();d.tasks.insert(task.id.clone(),task.clone());state.ocr.cancels.lock().unwrap().remove(&task.id);
    }
}
fn should_reset_engine(error:&str)->bool{["OCR 引擎","OCR 协议","OCR 返回","OCR 单页","OCR 行","OCR 输入","OCR 单文件","未知 OCR 事件","任务已取消"].iter().any(|prefix|error.starts_with(prefix))}

fn finish_workflow(state:&AppState,task:&mut OcrTask,app:&tauri::AppHandle,cancel:&AtomicBool)->Result<(),String>{
    let options=task.workflow.options.clone();
    let mut done=HashSet::new();
    let cancelled=||if cancel.load(Ordering::Relaxed){Err("任务已取消".to_owned())}else{Ok(())};
    cancelled()?;
    for i in 0..task.files.len(){
        if review_naming_warning(&mut task.files[i]){persist(state,task,app,Some(i))?;}
    }
    if options.export_format!="none"&&task.workflow.export_path.is_empty(){
        let directory=Path::new(&options.export_directory);
        if directory.canonicalize().map_err(|e|format!("导出目录不可用：{e}"))?!=directory{return Err("导出目录实际位置已变化，请重新设置任务选项".into());}
        task.workflow.export_path=export_workflow(state,task,app).map_err(|e|format!("自动导出失败：{e}"))?;
        persist(state,task,app,None)?;
    }
    cancelled()?;
    if options.rename!="review"{
        done={let d=state.ocr.data.lock().unwrap();d.batches.values().filter(|b|b.task_id==task.id).flat_map(|b|b.items.iter().filter(|i|i.status=="done").map(|i|i.file_id.clone())).collect::<HashSet<_>>()};
        let ids=task.files.iter().filter(|f|!done.contains(&f.id)&&f.profile.is_some()&&(f.status=="ready"||f.status=="review"&&f.reviewed)&&(options.rename!="apply"||f.warning.is_empty()||f.reviewed)).map(|f|f.id.clone()).collect::<Vec<_>>();
        if !ids.is_empty(){
            let preview=preview_rename(state,task.id.clone(),ids,true)?;
            task.workflow.rename_batch_id=preview.id.clone();persist(state,task,app,None)?;
            if options.rename=="apply"{
                cancelled()?;
                let result=apply_rename(state,preview.id,false,Some(cancel));
                if let Some(saved)=state.ocr.data.lock().unwrap().tasks.get(&task.id){task.files=saved.files.clone();}
                let applied=result?;
                done.extend(applied.items.iter().filter(|i|i.status=="done").map(|i|i.file_id.clone()));
                cancelled()?;
                if applied.summary.failed>0||applied.summary.blocked>0{return Err(format!("自动改名：{} 项成功、{} 项失败、{} 项被阻止。处理原因后可仅继续未完成步骤。",applied.summary.success,applied.summary.failed,applied.summary.blocked));}
            }
        }
    }
    task.workflow.status=workflow_completion_status(task,&done).into();
    Ok(())
}
fn workflow_completion_status(task:&OcrTask,renamed:&HashSet<String>)->&'static str{
    if task.files.iter().any(|f|f.status!="ready"&&!f.reviewed||!f.warning.is_empty()&&!f.reviewed)
        ||task.workflow.options.rename=="preview"
        ||task.workflow.options.rename=="apply"&&task.files.iter().any(|f|!renamed.contains(&f.id)){"review"}else{"completed"}
}

fn naming_warning(file:&OcrFileResult)->String{
    if let Some(profile)=&file.profile{
        let (generated,warning)=rules::filename_with_warning(profile,&file.fields,&file.path);
        if generated==file.proposed_name{return warning;}
    }
    String::new()
}
fn review_naming_warning(file:&mut OcrFileResult)->bool{
    if file.reviewed||!["ready","review"].contains(&file.status.as_str()){return false;}
    let warning=naming_warning(file);
    if warning.is_empty(){return false;}
    let mut changed=file.status!="review";
    file.status="review".into();
    if !file.warning.contains(&warning){
        if !file.warning.is_empty(){file.warning.push_str("；");}
        file.warning.push_str(&warning);changed=true;
    }
    changed
}

#[tauri::command]pub fn ocr_resume_workflow(state:tauri::State<Arc<AppState>>,app:tauri::AppHandle,id:String)->Result<(),String>{
    let mut d=state.ocr.data.lock().unwrap();let mut task=d.tasks.get(&id).cloned().ok_or("任务不存在")?;
    if ["queued","running"].contains(&task.status.as_str())||state.ocr.cancels.lock().unwrap().contains_key(&id){return Err("任务仍在执行或正在收尾，请稍后重试".into());}
    if !task.workflow.enabled{return Err("此任务未启用一键完成".into());}
    if task.files.iter().any(|f|f.status=="relocated"){return Err("文件位置已变化，请重新导入文件后建立新任务".into());}
    if d.tasks.values().any(|other|other.id!=id&&["queued","running"].contains(&other.status.as_str())&&other.files.iter().any(|f|task.files.iter().any(|next|next.path.eq_ignore_ascii_case(&f.path)))){return Err("这些文件已有其他任务运行，请等待完成".into());}
    let mut options=task.workflow.options.clone();
    if !task.workflow.export_path.is_empty(){options.export_format="none".into();}
    let directory=options.export_directory.clone();validate_workflow(&mut options)?;
    if options.export_directory!=directory{return Err("导出目录实际位置已变化，请重新设置任务选项".into());}
    if d.queue.len()>=20{return Err("排队任务过多，请稍后重试".into());}
    task.workflow.error.clear();task.workflow.status="pending".into();task.status="queued".into();
    state.ocr.save_task_header(&task)?;d.tasks.insert(id.clone(),task);state.ocr.cancels.lock().unwrap().insert(id.clone(),Arc::new(AtomicBool::new(false)));d.queue.push_back(id);
    let start=!d.running;if start{d.running=true;}drop(d);
    if start{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||run_queue(state,app));}Ok(())
}

#[tauri::command]pub fn ocr_update_result(state:tauri::State<Arc<AppState>>,task_id:String,file_id:String,values:BTreeMap<String,String>,proposed_name:String,reviewed:bool)->Result<OcrTask,String>{
    let mut d=state.ocr.data.lock().unwrap();let mut task=d.tasks.get(&task_id).cloned().ok_or("任务不存在")?;if ["queued","running"].contains(&task.status.as_str()){return Err("请等待任务结束后修改".into());}
    let f=task.files.iter_mut().find(|f|f.id==file_id).ok_or("文件不存在")?;if !["ready","review"].contains(&f.status.as_str()){return Err("只能修改已识别的结果".into());}
    for (key,value) in values{if value.len()>10000{return Err("字段值过长".into());}let r=f.fields.get_mut(&key).ok_or("字段不存在")?;if r.value!=value{r.value=value;r.source="manual".into();r.confidence=None;r.review=false;}}
    f.proposed_name=if proposed_name.is_empty(){if let Some(p)=&f.profile{rules::filename(p,&f.fields,&f.path)}else{f.original_name.clone()}}else{valid_name(&proposed_name,&f.path)?;proposed_name};
    f.reviewed=reviewed;let index=task.files.iter().position(|f|f.id==file_id).unwrap();state.ocr.save_task_file(&task,index)?;d.tasks.insert(task_id,task.clone());Ok(task)
}
// Invalidate before a workspace rename. Even a crash between moving the file and
// updating the UI cannot leave a durable OCR write grant pointing at the old name.
pub(crate) fn invalidate_workspace_paths(store:&OcrStore,d:&mut store::Data,original:&str,target:&str)->Result<(),String>{
    let affected=|path:&str|crate::workspace_rename::affects(path,original,target);
    for task in d.tasks.values_mut(){
        let mut changed=false;
        for i in 0..task.files.len(){
            if affected(&task.files[i].path){
                let file=&mut task.files[i];file.status="relocated".into();file.fingerprint.clear();file.reviewed=false;
                file.error="此路径受工作区改名影响，旧结果已失效，请从实际位置重新导入".into();
                store.save_task_file(task,i)?;changed=true;
            }
        }
        if changed{task.workflow.status="interrupted".into();task.workflow.error="文件位置发生变化，请重新导入后建立新任务".into();store.save_task_header(task)?;}
    }
    for batch in d.batches.values_mut(){
        let mut changed=false;
        for item in &mut batch.items{if affected(&item.original)||affected(&item.target){item.status="conflict".into();item.error="工作区改名已使旧路径失效；禁止继续改名或撤销，请人工核对".into();changed=true;}}
        if changed{batch.status="invalidated".into();batch.summarize();store.save_batch(batch)?;}
    }
    d.grants.retain(|path|!affected(path));Ok(())
}
fn valid_name(name:&str,source:&str)->Result<(),String>{
    crate::workspace_rename::validate_name(name)?;
    if Path::new(name).extension().map(|s|s.to_string_lossy().to_lowercase())!=Path::new(source).extension().map(|s|s.to_string_lossy().to_lowercase()){return Err("必须保留原文件扩展名".into());}
    Ok(())
}
#[tauri::command]pub async fn ocr_preview_rename(state:tauri::State<'_,Arc<AppState>>,task_id:String,file_ids:Vec<String>)->Result<OcrRenameBatch,String>{
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||preview_rename(&state,task_id,file_ids,false)).await.map_err(|e|e.to_string())?
}
fn preview_rename(state:&AppState,task_id:String,file_ids:Vec<String>,workflow:bool)->Result<OcrRenameBatch,String>{
    let mut d=state.ocr.data.lock().unwrap();let task=d.tasks.get(&task_id).ok_or("任务不存在")?;if !workflow&&["queued","running"].contains(&task.status.as_str()){return Err("任务尚未结束".into());}
    let mut reserved=HashSet::new();let mut items=vec![];
    for f in task.files.iter().filter(|f|file_ids.contains(&f.id)){
        let mut item=OcrRenameItem{file_id:f.id.clone(),original:f.path.clone(),target:f.path.clone(),status:"pending".into(),error:String::new(),fingerprint:String::new(),warning:String::new()};
        let checked=(||->Result<(),String>{
            if !["ready","review"].contains(&f.status.as_str())||f.status=="review"&&!f.reviewed{return Err("请先完成字段复核".into());}
            valid_name(&f.proposed_name,&f.path)?;let original=store::safe_file(Path::new(&f.path))?;let fingerprint=store::fingerprint(&original)?;
            if fingerprint!=f.fingerprint{return Err("文件身份或内容已变化，请重新识别".into());}
            let parent=original.parent().ok_or("路径无父目录")?;let mut target=parent.join(&f.proposed_name);
            let stem=Path::new(&f.proposed_name).file_stem().ok_or("文件名无效")?.to_string_lossy();let ext=Path::new(&f.proposed_name).extension().ok_or("缺少扩展名")?.to_string_lossy();let mut suffix=1;
            while (target.exists()&&target!=original)||reserved.contains(&target.to_string_lossy().to_lowercase()){target=parent.join(format!("{stem}_{suffix:02}.{ext}"));suffix+=1;}
            if target.as_os_str().to_string_lossy().encode_utf16().count()>240{return Err("目标完整路径超过 240 字符，请缩短名称或移到较短目录后重新识别".into());}
            if suffix>1{item.warning="目标名称重复，已自动添加序号".into();}
            let warning=naming_warning(f);if !warning.is_empty(){if !item.warning.is_empty(){item.warning.push_str("；");}item.warning.push_str(&warning);}
            reserved.insert(target.to_string_lossy().to_lowercase());item.original=original.to_string_lossy().into_owned();item.target=target.to_string_lossy().into_owned();item.fingerprint=fingerprint;Ok(())
        })();
        if let Err(error)=checked{item.status="blocked".into();item.error=error;}items.push(item);
    }
    if items.is_empty(){return Err("请选择需要改名的结果".into());}
    let mut batch=OcrRenameBatch{id:uuid::Uuid::new_v4().to_string(),task_id,status:"preview".into(),items,summary:Default::default()};batch.summarize();state.ocr.save_batch(&batch)?;d.batches.insert(batch.id.clone(),batch.clone());Ok(batch)
}
#[tauri::command]pub async fn ocr_apply_rename(state:tauri::State<'_,Arc<AppState>>,batch_id:String,undo:bool)->Result<OcrRenameBatch,String>{
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||apply_rename(&state,batch_id,undo,None)).await.map_err(|e|e.to_string())?
}
fn apply_rename(state:&AppState,batch_id:String,undo:bool,cancel:Option<&AtomicBool>)->Result<OcrRenameBatch,String>{
    let mut d=state.ocr.data.lock().unwrap();let mut batch=d.batches.get(&batch_id).cloned().ok_or("改名批次不存在")?;
    if !undo&&batch.status!="preview"{return Err("此预览已经执行，请重新生成预览".into());}if undo&&batch.status=="preview"{return Err("此批次尚未执行".into());}
    if !batch.items.iter().any(|i|i.status==if undo{"done"}else{"pending"}){return Err("没有可执行的项目".into());}
    if undo{batch.status="rollback".into();}
    let indices:Vec<_>=if undo{(0..batch.items.len()).rev().collect()}else{(0..batch.items.len()).collect()};
    for i in indices{
        if cancel.is_some_and(|c|c.load(Ordering::Relaxed)){break;}
        let item=batch.items[i].clone();if undo&&item.status!="done"||!undo&&item.status!="pending"{continue;}
        let(from,to)=if undo{(&item.target,&item.original)}else{(&item.original,&item.target)};
        let result=(||->Result<(),String>{
            if store::fingerprint(Path::new(from))?!=item.fingerprint{return Err("文件身份或内容已变化，未操作".into());}
            if !undo{let task=d.tasks.get(&batch.task_id).ok_or("任务已不存在")?;let f=task.files.iter().find(|f|f.id==item.file_id).ok_or("结果不存在")?;if f.path!=item.original||f.status=="review"&&!f.reviewed{return Err("结果已变化，请重新生成预览".into());}}
            batch.items[i].status=if undo{"undoing"}else{"applying"}.into();state.ocr.save_batch(&batch)?;
            if from!=to{store::move_no_replace(Path::new(from),Path::new(to))?;}Ok(())
        })();
        match result{
            Ok(())=>{batch.items[i].status=if undo{"undone"}else{"done"}.into();batch.items[i].error.clear();},
            Err(e)=>{batch.items[i].status=if undo{"done"}else{"failed"}.into();batch.items[i].error=e;}
        }
        // 文件操作结果先持久化，后更新识别结果路径；记录更新失败也不能丢失撤销依据。
        state.ocr.save_batch(&batch)?;d.batches.insert(batch.id.clone(),batch.clone());
        if batch.items[i].error.is_empty(){
            if let Some(t)=d.tasks.get_mut(&batch.task_id){if let Some(index)=t.files.iter().position(|f|f.id==item.file_id){t.files[index].path=to.clone();if let Err(e)=state.ocr.save_task_file(t,index){batch.items[i].warning=format!("文件操作已完成，但识别记录保存失败：{e}");}}}
            d.grants.insert(to.clone());
        }
    }
    batch.status=if undo{"rollback"}else if cancel.is_some_and(|c|c.load(Ordering::Relaxed)){"interrupted"}else{"executed"}.into();batch.summarize();state.ocr.save_batch(&batch)?;d.batches.insert(batch.id.clone(),batch.clone());let _=state.index.refresh.send(());Ok(batch)
}

fn export_status(s:&str)->&str{match s{"relocated"=>"路径已变化，请重新导入","ready"=>"已就绪","review"=>"需复核","failed"=>"失败","cancelled"=>"已取消","interrupted"=>"已中断","pending"=>"待执行","done"=>"已改名","undone"=>"已撤销","blocked"=>"已排除","conflict"=>"冲突","running"=>"处理中","queued"=>"排队中",_=>s}}
fn csv_cell(s:&str)->String{let prefix=if s.trim_start().starts_with(['=','+','-','@','\t','\r']){"'"}else{""};format!("\"{prefix}{}\"",s.replace('"',"\"\""))}
#[tauri::command]pub async fn ocr_export(state:tauri::State<'_,Arc<AppState>>,task_id:String,format:String,path:String,failures_only:Option<bool>,batch_id:Option<String>)->Result<String,String>{
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||export_task(&state,task_id,format,path,failures_only,batch_id)).await.map_err(|e|e.to_string())?
}
fn export_task(state:&AppState,task_id:String,format:String,path:String,failures_only:Option<bool>,batch_id:Option<String>)->Result<String,String>{
    if let Some(id)=batch_id{
        if format!="csv"{return Err("改名异常记录请导出为 CSV".into());}
        let d=state.ocr.data.lock().unwrap();let batch=d.batches.get(&id).filter(|b|b.task_id==task_id).ok_or("改名记录不存在")?;
        let mut rows=vec![["原路径","目标路径","状态","失败原因","提示"].map(csv_cell).join(",")];
        for item in batch.items.iter().filter(|i|!i.error.is_empty()){rows.push([item.original.as_str(),item.target.as_str(),export_status(&item.status),item.error.as_str(),item.warning.as_str()].map(csv_cell).join(","));}
        return write_export(&format,&path,format!("\u{feff}{}",rows.join("\r\n")).as_bytes());
    }
    let mut task=state.ocr.data.lock().unwrap().tasks.get(&task_id).cloned().ok_or("任务不存在")?;
    if failures_only.unwrap_or(false){task.files.retain(|f|["failed","cancelled","interrupted"].contains(&f.status.as_str()));}
    write_export(&format,&path,&export_bytes(&task,&format)?)
}
fn export_bytes(task:&OcrTask,format:&str)->Result<Vec<u8>,String>{
    Ok(match format{
        "json"=>serde_json::to_vec_pretty(&task).map_err(|e|e.to_string())?,
        "txt"=>task.files.iter().map(|f|format!("{}\n{}\n",f.original_name,f.lines.iter().map(|l|format!("[第 {} 页] {}",l.page,l.text)).collect::<Vec<_>>().join("\n"))).collect::<Vec<_>>().join("\n").into_bytes(),
        "csv"=>{let keys:std::collections::BTreeSet<_>=task.files.iter().flat_map(|f|f.fields.keys().cloned()).collect();let extras=["状态","失败原因","提示","当前文件名"];let mut rows=vec![std::iter::once("文件名".to_owned()).chain(keys.iter().cloned()).chain(extras.map(String::from)).map(|s|csv_cell(&s)).collect::<Vec<_>>().join(",")];for f in &task.files{rows.push(std::iter::once(f.original_name.clone()).chain(keys.iter().map(|k|f.fields.get(k).map(|v|v.value.clone()).unwrap_or_default())).chain([export_status(&f.status).into(),f.error.clone(),f.warning.clone(),Path::new(&f.path).file_name().unwrap_or_default().to_string_lossy().into_owned()]).map(|s|csv_cell(&s)).collect::<Vec<_>>().join(","));}format!("\u{feff}{}",rows.join("\r\n")).into_bytes()},_=>return Err("不支持的导出格式".into())})
}
fn workflow_export_path(task:&OcrTask)->std::path::PathBuf{
    let suffix=if task.workflow.export_attempt==0{String::new()}else{format!("_{}",task.workflow.export_attempt)};
    Path::new(&task.workflow.options.export_directory).join(format!("OCR-{}{suffix}.{}",task.id,task.workflow.options.export_format))
}
fn export_matches(path:&Path,expected:&str)->Result<bool,String>{
    use std::io::Read;
    use sha2::{Digest,Sha256};
    let meta=match std::fs::symlink_metadata(path){Ok(meta)=>meta,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(false),Err(e)=>return Err(e.to_string())};
    if !meta.is_file()||meta.file_type().is_symlink(){return Ok(false);}
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Ok(false);}}
    let mut file=std::fs::File::open(path).map_err(|e|e.to_string())?;
    let mut hash=Sha256::new();let mut buffer=[0u8;65536];
    loop{let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break;}hash.update(&buffer[..n]);}
    Ok(format!("{:x}",hash.finalize())==expected)
}
fn export_workflow(state:&AppState,task:&mut OcrTask,app:&tauri::AppHandle)->Result<String,String>{
    use sha2::{Digest,Sha256};
    let mut path=workflow_export_path(task);
    // 校验上次已发布但尚未记录成功的文件，不依赖恢复后可能变化的任务内容。
    if !task.workflow.export_sha256.is_empty()&&export_matches(&path,&task.workflow.export_sha256)?{return Ok(path.to_string_lossy().into_owned());}
    task.workflow.export_sha256.clear();
    loop{
        match std::fs::symlink_metadata(&path){
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>break,
            Err(e)=>return Err(e.to_string()),
            Ok(_)=>{task.workflow.export_attempt=task.workflow.export_attempt.checked_add(1).ok_or("导出文件重名次数过多")?;path=workflow_export_path(task);}
        }
    }
    let bytes=export_bytes(task,&task.workflow.options.export_format)?;
    task.workflow.export_sha256=format!("{:x}",Sha256::digest(&bytes));
    // 发布文件之前保存导出意图；失败时不会继续改名。
    persist(state,task,app,None)?;
    write_export(&task.workflow.options.export_format,&path.to_string_lossy(),&bytes)
}
fn write_export(format:&str,path:&str,bytes:&[u8])->Result<String,String>{
    if !Path::new(path).is_absolute()||Path::new(path).extension().and_then(|v|v.to_str())!=Some(format){return Err("请选择扩展名匹配的绝对路径".into());}
    use std::io::Write;
    let mut file=tempfile::NamedTempFile::new_in(Path::new(path).parent().ok_or("导出路径无父目录")?).map_err(|e|e.to_string())?;
    file.write_all(bytes).and_then(|_|file.as_file().sync_all()).map_err(|e|e.to_string())?;
    file.persist_noclobber(path).map_err(|e|format!("无法创建导出文件（不会覆盖已有文件）：{e}"))?;
    Ok(path.into())
}
#[tauri::command]pub async fn ocr_open_file(state:tauri::State<'_,Arc<AppState>>,task_id:String,file_id:String,reveal:bool)->Result<(),String>{
    let path={let d=state.ocr.data.lock().unwrap();let task=d.tasks.get(&task_id).ok_or("任务不存在")?;task.files.iter().find(|f|f.id==file_id&&f.status!="relocated").ok_or("文件位置已变化或结果已失效，请重新导入")?.path.clone()};
    tauri::async_runtime::spawn_blocking(move||{let p=store::safe_file(Path::new(&path))?;if reveal{crate::shell::reveal(vec![p])?;}else{open::that_detached(p).map_err(|e|e.to_string())?;}Ok(())}).await.map_err(|e|e.to_string())?
}
