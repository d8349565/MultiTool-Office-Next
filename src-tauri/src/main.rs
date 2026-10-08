#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod settings;
mod pricing;
mod index;
mod ai;
mod pi_runtime;
mod model_adapter;
mod assistant_work;
mod assistant_context;
mod assistant_gateway;
mod assistant_reports;
mod task_state;
mod assistant_profile;
mod assistant_images;
mod tavily;
mod assistant_tools;
mod shell;
mod window_state;
mod ocr;
mod file_preview;
mod todo_reminders;
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool,Ordering}},time::Instant};
use serde_json::{json,Value};
use tauri::{Manager, Emitter};
use index::{Index,SearchProvider,Query};

pub struct AppState {
    file_previews: file_preview::Previews,
    todo_reminders: todo_reminders::TodoReminders,
    ocr:ocr::OcrStore,
    dir:std::path::PathBuf, settings:Mutex<settings::Settings>, index:Arc<Index>,
    reports:Mutex<HashMap<String,std::path::PathBuf>>,
    proposals:Mutex<HashMap<String,settings::Settings>>,tasks:Mutex<HashMap<String,Arc<AtomicBool>>>,
    task_results:Mutex<HashMap<String,Value>>,
    pi_sessions:Mutex<HashMap<String,Arc<pi_runtime::Link>>>,
}
fn make_proposal(state:&AppState,old:&settings::Settings,next:settings::Settings)->Value{
    let id=uuid::Uuid::new_v4().to_string();let value=json!({"id":id,"before":settings::redacted(old),"after":settings::redacted(&next)});
    let mut proposals=state.proposals.lock().unwrap();if proposals.len()>50{proposals.clear();}proposals.insert(id,next);value
}
#[tauri::command] fn bootstrap(state:tauri::State<Arc<AppState>>)->Value{json!({"settings":state.settings.lock().unwrap().clone(),"status":state.index.status.lock().unwrap().clone(),"keys":{"tavily":ai::key("tavily").and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok(),"model":ai::key("model").and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok(),"jev":ai::key("jev").and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok()}})}
#[tauri::command] async fn list_dirs(state:tauri::State<'_,Arc<AppState>>,path:String)->Result<Vec<index::Entry>,String>{let idx=state.index.clone();tauri::async_runtime::spawn_blocking(move||idx.dirs(&path)).await.map_err(|e|e.to_string())?}
#[tauri::command] async fn search(state:tauri::State<'_,Arc<AppState>>,mut query:Query)->Result<index::Results,String>{
    let idx=state.index.clone();
    tauri::async_runtime::spawn_blocking(move||{
        if let Some(root)=&query.root{query.root=Some(idx.authorize(root)?.to_string_lossy().into_owned());}
        Ok(idx.search(&query))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command] fn index_status(state:tauri::State<Arc<AppState>>)->index::Status{state.index.status.lock().unwrap().clone()}
#[tauri::command] fn reindex(state:tauri::State<Arc<AppState>>){let _=state.index.refresh.send(());}
#[tauri::command] fn save_settings(state:tauri::State<Arc<AppState>>,next:settings::Settings)->Result<settings::Settings,String>{
    let mut current=state.settings.lock().unwrap();let next=settings::save(&state.dir,&current,next)?;let roots_changed=next.roots!=current.roots;*current=next.clone();if roots_changed{state.index.configure(&next.roots);}Ok(next)
}
#[tauri::command] fn decide_proposal(state:tauri::State<Arc<AppState>>,id:String,approve:bool)->Result<settings::Settings,String>{
    let next=state.proposals.lock().unwrap().remove(&id).ok_or("提案已失效")?;
    if approve {save_settings(state,next)}else{Ok(state.settings.lock().unwrap().clone())}
}
#[tauri::command] fn set_key(provider:String,secret:String)->Result<(),String>{let entry=ai::key(&provider)?;if secret.is_empty(){match entry.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(e)=>Err(e.to_string())}}else{entry.set_password(&secret).map_err(|e|e.to_string())}}
#[tauri::command] async fn model_test(state:tauri::State<'_,Arc<AppState>>,model_url:String,model_id:String)->Result<Value,String>{
    let mut s=state.settings.lock().unwrap().clone();s.model_url=model_url;s.model_id=model_id;
    settings::validate(&s)?;ai::test_connection(&s).await
}
#[tauri::command] fn import_settings(state:tauri::State<Arc<AppState>>,path:String)->Result<settings::Settings,String>{settings::import(Path::new(&path),&state.settings.lock().unwrap())}
#[tauri::command] fn export_settings(state:tauri::State<Arc<AppState>>,path:String)->Result<(),String>{settings::export(Path::new(&path),&state.settings.lock().unwrap())}
#[tauri::command] async fn open_path(state:tauri::State<'_,Arc<AppState>>,path:String,reveal:bool)->Result<(),String>{
    let idx=state.index.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let p=idx.authorize(&path)?;
        if reveal {let result=shell::reveal(vec![p])?;if let Some(failed)=result["groups"].as_array().and_then(|g|g.iter().find(|g|g["status"]=="failed")){return Err(failed["error"].as_str().unwrap_or("定位失败").into());}return Ok(());
        }open::that_detached(p).map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}
fn reveal_authorized(state:&AppState,paths:Vec<String>)->Result<Value,String>{let paths=paths.iter().map(|p|state.index.authorize(p)).collect::<Result<Vec<_>,_>>()?;shell::reveal(paths)}
#[tauri::command] async fn reveal_paths(state:tauri::State<'_,Arc<AppState>>,paths:Vec<String>)->Result<Value,String>{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||reveal_authorized(&state,paths)).await.map_err(|e|e.to_string())?}
#[tauri::command] async fn launch(state:tauri::State<'_,Arc<AppState>>,id:String)->Result<(),String>{
    let path=state.settings.lock().unwrap().launchers.iter().find(|l|l.id==id).map(|l|l.path.clone()).ok_or("工具不存在")?;
    tauri::async_runtime::spawn_blocking(move||shell::launch(&path)).await.map_err(|e|e.to_string())?
}
#[tauri::command] async fn reveal_launcher(state:tauri::State<'_,Arc<AppState>>,id:String)->Result<(),String>{
    let path=state.settings.lock().unwrap().launchers.iter().find(|l|l.id==id).map(|l|l.path.clone()).ok_or("工具不存在")?;
    tauri::async_runtime::spawn_blocking(move||{
        let p=match settings::launcher_target(&path)?{settings::LauncherTarget::Local(p)=>p,settings::LauncherTarget::Web(_)=>return Err("网页入口没有本地目录可定位".into())};
        if !p.exists(){return Err("工具目标已不存在".into());}
        let result=shell::reveal(vec![p.to_path_buf()])?;
        if let Some(failed)=result["groups"].as_array().and_then(|g|g.iter().find(|g|g["status"]=="failed")){
            return Err(failed["error"].as_str().unwrap_or("定位失败").into());
        }
        Ok(())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command] fn assistant_documents(state:tauri::State<Arc<AppState>>)->Result<Value,String>{assistant_profile::documents(&state.dir)}
#[tauri::command] fn save_assistant_document(state:tauri::State<Arc<AppState>>,name:String,text:String,previous:String)->Result<Value,String>{assistant_profile::save(&state.dir,&name,&text,&previous)}
#[tauri::command] async fn open_web_url(url:String)->Result<(),String>{
    let url=tavily::public_url(&url).ok_or("仅支持公开网页链接")?;
    tauri::async_runtime::spawn_blocking(move||open::that_detached(url).map_err(|_|"无法打开浏览器".to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command] async fn assistant_workspace(state:tauri::State<'_,Arc<AppState>>,path:Option<String>,open:Option<bool>)->Result<Value,String>{
    let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let folder=assistant_tools::report_folder(&state,path.as_deref())?;
        if open.unwrap_or(false){open::that_detached(&folder).map_err(|_|"无法打开报告目录".to_string())?;}
        Ok(json!({"path":folder.to_string_lossy()}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command] async fn open_report(state:tauri::State<'_,Arc<AppState>>,id:String)->Result<(),String>{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||assistant_tools::open_report(&state,&id)).await.map_err(|e|e.to_string())?}
#[tauri::command] fn cancel_task(state:tauri::State<Arc<AppState>>,id:String){if let Some(c)=state.tasks.lock().unwrap().get(&id){c.store(true,Ordering::Relaxed);}}
#[tauri::command] fn assistant_budget_proposal(state:tauri::State<Arc<AppState>>)->Result<Value,String>{
    let old=state.settings.lock().unwrap().clone();let next=settings::patch(&old,&json!({"modelRequestTimeoutSecs":300,"assistantTaskTimeoutSecs":600,"modelFirstResponseTimeoutSecs":45,"modelIdleTimeoutSecs":60,"assistantReasoning":"max"}))?;
    let mut p=make_proposal(&state,&old,next);p["reason"]=json!("原来的45秒总超时可能中断仍在输出的思考；将首响应、停滞与总预算分开。");p["impact"]=json!("持续输出时允许继续，等待最长可能增加；仍受总预算限制，修改仅在同意后生效。");Ok(p)
}
#[tauri::command] fn task_status(state:tauri::State<Arc<AppState>>,id:String)->Result<Value,String>{task_state::get(&state,&id)}
#[tauri::command] fn assistant_context(state:tauri::State<Arc<AppState>>,session_id:String)->Result<Value,String>{serde_json::to_value(assistant_context::load(&state,&session_id)?).map_err(|e|e.to_string())}
#[tauri::command] fn delete_assistant_session(state:tauri::State<Arc<AppState>>,session_id:String)->Result<(),String>{assistant_context::delete_session(&state,&session_id)}
#[tauri::command] async fn ai_task(state:tauri::State<'_,Arc<AppState>>,app:tauri::AppHandle,id:String,kind:String,text:String,language:Option<String>,context:Option<Value>,items:Option<Value>)->Result<Value,String>{
    let state=state.inner().clone();let cancel=Arc::new(AtomicBool::new(false));let session=context.as_ref().and_then(|c|c["sessionId"].as_str()).unwrap_or(&id).to_owned();{
        let mut tasks=state.tasks.lock().unwrap();if tasks.contains_key(&id)||tasks.len()>=4{return Err("已有任务运行，请稍后重试".into());}tasks.insert(id.clone(),cancel.clone());
        if kind=="agent"{
            if state.task_results.lock().unwrap().values().any(|v|v["status"]=="running"&&v["sessionId"]==session){tasks.remove(&id);return Err("本会话已有任务运行，请等待或取消后继续".into());}
            task_state::start(&state,&id,"agent",&session);
        }
    }
    let start=Instant::now();let settings=state.settings.lock().unwrap().clone();
    let result=match kind.as_str(){
        "translate"=>ai::translate_stream(app,id.clone(),&settings,&text,language.as_deref().unwrap_or("zh"),cancel.clone()).await,
        "agent"=>{let budget=settings.assistant_task_timeout_secs;let c=cancel.clone();match tokio::time::timeout(std::time::Duration::from_secs(budget),ai::run_with_pi(state.clone(),text,context.unwrap_or(Value::Null),cancel,app,id.clone())).await{Ok(_) if c.load(Ordering::Relaxed)=>Err("任务已取消".into()),Ok(v)=>v,Err(_)=>{c.store(true,Ordering::Relaxed);Err(format!("任务达到 {budget} 秒总预算"))}}},
        "jev"=>if settings.jev_enabled {ai::jev(&text,items.unwrap_or(json!([])),&cancel).await}else{Err("请先在设置中启用 Jev 实验功能".into())},
        _=>Err("未知任务".into()),
    };
    state.tasks.lock().unwrap().remove(&id);
    state.pi_sessions.lock().unwrap().remove(&id);
    let result=if kind=="agent"{Ok(task_state::finish(&state,&id,result))}else{result};
    ai::log(&state,&id,&kind,start,&result);result
}
#[tauri::command]
fn get_todos(state: tauri::State<Arc<AppState>>) -> Result<Value, String> {
    state.todo_reminders.read(&state.dir)
}
#[tauri::command]
fn save_todos(state: tauri::State<Arc<AppState>>, todos: Value) -> Result<(), String> {
    state.todo_reminders.save(&state.dir, todos)
}
#[tauri::command]
fn get_todo_reminder_status(state: tauri::State<Arc<AppState>>) -> Option<String> {
    state.todo_reminders.status()
}
#[tauri::command]
async fn todo_ai_assist(state: tauri::State<'_, Arc<AppState>>, action: String, text: Option<String>, items: Option<Value>) -> Result<Value, String> {
    let state = state.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let text = text.unwrap_or_default();
    ai::todo_assist(state, action, text, items.unwrap_or(json!([])), cancel).await
}
fn show_main_window(app:&tauri::AppHandle){
    if let Some(window)=app.get_webview_window("main"){
        let _=window.show();let _=window.unminimize();let _=window.set_focus();
    }
}
fn main(){
    tauri::Builder::default()
        // 必须先拦截重复启动，避免再次初始化索引、提醒和托盘。
        .plugin(tauri_plugin_single_instance::init(|app,_,_|show_main_window(app)))
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 关闭窗口保留后台提醒；托盘菜单的“退出”结束程序。
                    if window.hide().is_ok() { api.prevent_close(); }
                }
            }
        })
        .on_page_load(|webview,payload|{if webview.label()=="main"&&matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){
            #[cfg(debug_assertions)] if std::env::var("OFFICE_NEXT_TEST_WINDOW_HIDDEN").as_deref()==Ok("1"){return;}
            let _=webview.window().show();
        }})
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{
            use tauri_plugin_global_shortcut::ShortcutState;
            if event.state()==ShortcutState::Pressed {show_main_window(app);if let Some(w)=app.get_webview_window("main"){let _=w.emit("quick-open",());}}
        }).build())
        .setup(|app|{
            let dir=app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let dir=std::env::var_os("OFFICE_NEXT_TEST_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(dir);
            std::fs::create_dir_all(&dir)?;
            if let Some(window)=app.get_webview_window("main"){window_state::install(window,&dir);}
            let settings=settings::load(&dir).map_err(std::io::Error::other)?;
            let (index,rx)=Index::open(&dir).map_err(std::io::Error::other)?;index.configure(&settings.roots);index.clone().spawn(rx);
            let reports=std::fs::read(dir.join("reports.json")).ok().and_then(|data|serde_json::from_slice::<HashMap<String,std::path::PathBuf>>(&data).ok()).unwrap_or_default();
            let ocr_exe=if cfg!(debug_assertions){std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ocr-worker/ocr-worker.exe")}else{app.path().resource_dir()?.join("ocr-worker/ocr-worker.exe")};
            let ocr=match ocr::OcrStore::open(&dir,ocr_exe.clone()){Ok(store)=>store,Err(error)=>{eprintln!("OCR initialization failed: {error}");ocr::OcrStore::disabled(&dir,ocr_exe,error).map_err(std::io::Error::other)?}};
            app.manage(Arc::new(AppState{file_previews:file_preview::Previews::default(),dir,ocr,todo_reminders:todo_reminders::TodoReminders::default(),settings:Mutex::new(settings),index,reports:Mutex::new(reports),proposals:Mutex::new(HashMap::new()),tasks:Mutex::new(HashMap::new()),task_results:Mutex::new(HashMap::new()),pi_sessions:Mutex::new(HashMap::new())}));
            todo_reminders::TodoReminders::start(app.handle().clone());
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(e)=app.global_shortcut().register("CommandOrControl+Shift+Space"){eprintln!("Shortcut unavailable: {e}");}
            let menu=tauri::menu::Menu::with_items(app,&[
                &tauri::menu::MenuItem::with_id(app,"show","打开工作台",true,None::<&str>)?,
                &tauri::menu::MenuItem::with_id(app,"quit","退出",true,None::<&str>)?
            ])?;
            let mut tray=tauri::tray::TrayIconBuilder::new().tooltip("工作台 · 待办提醒在后台运行").menu(&menu).on_menu_event(|app,event|match event.id.as_ref(){"show"=>show_main_window(app),"quit"=>app.exit(0),_=>{}});
            if let Some(icon)=app.default_window_icon(){tray=tray.icon(icon.clone());}tray.build(app)?;Ok(())
        })
        .invoke_handler(tauri::generate_handler![file_preview::file_preview,file_preview::cancel_file_preview,model_test,pi_runtime::pi_step,bootstrap,assistant_documents,save_assistant_document,open_web_url,list_dirs,search,index_status,reindex,save_settings,import_settings,export_settings,decide_proposal,set_key,open_path,reveal_paths,launch,reveal_launcher,assistant_workspace,open_report,cancel_task,task_status,assistant_context,delete_assistant_session,assistant_budget_proposal,ai_task,get_todos,save_todos,get_todo_reminder_status,todo_ai_assist,ocr::ocr_bootstrap,ocr::ocr_preview_sample,ocr::ocr_save_profile,ocr::ocr_delete_profile,ocr::ocr_import_profiles,ocr::ocr_generate_profile,ocr::ocr_import_files,ocr::ocr_get_task,ocr::ocr_start_task,ocr::ocr_cancel_task,ocr::ocr_delete_task,ocr::ocr_clear_completed_tasks,ocr::ocr_update_result,ocr::ocr_preview_rename,ocr::ocr_apply_rename,ocr::ocr_export,ocr::ocr_open_file,ocr::ocr_export_profile])
        .run(tauri::generate_context!()).expect("MultiTool Office failed to start");
}
