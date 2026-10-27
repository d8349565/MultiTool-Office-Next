#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod settings;
mod network;
mod pricing;
mod index;
mod ai;
mod pi_runtime;
mod model_adapter;
mod model_context;
mod model_profiles;
mod assistant_work;
mod assistant_context;
mod assistant_gateway;
mod assistant_reports;
mod assistant_fs;
mod assistant_workspace;
mod assistant_documents;
mod assistant_spreadsheet;
mod assistant_pdf;
mod assistant_html;
mod task_state;
mod assistant_profile;
mod assistant_images;
mod tavily;
mod web_search;
mod assistant_tools;
mod shell;
mod window_state;
mod ocr;
mod file_preview;
mod workspace_rename;
mod todo_reminders;
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool,Ordering}},time::Instant};
use serde_json::{json,Value};
use tauri::{Manager, Emitter};
use index::{Index,SearchProvider,Query};

pub struct AppState {
    workspace_renames:workspace_rename::Renames,
    workspace:assistant_workspace::Workspace,
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
#[tauri::command] fn bootstrap(state:tauri::State<Arc<AppState>>)->Value{let settings=state.settings.lock().unwrap().clone();let model_key=model_profiles::credential(settings.active_model_profile_id.as_deref());json!({"settings":settings,"status":state.index.status.lock().unwrap().clone(),"keys":{"tavily":ai::key("tavily").and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok(),"model":ai::key(&model_key).and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok(),"jev":ai::key("jev").and_then(|k|k.get_password().map_err(|e|e.to_string())).is_ok()}})}
#[tauri::command] async fn list_dirs(state:tauri::State<'_,Arc<AppState>>,path:String)->Result<Vec<index::Entry>,String>{let idx=state.index.clone();tauri::async_runtime::spawn_blocking(move||idx.dirs(&path)).await.map_err(|e|e.to_string())?}
#[tauri::command] async fn locate_entry(state:tauri::State<'_,Arc<AppState>>,path:String,is_dir:bool)->Result<Value,String>{
    let idx=state.index.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let path=idx.authorize(&path)?;
        if is_dir&&path.file_name().is_none(){
            std::fs::read_dir(&path).map_err(|e|format!("无法访问目录：{e}"))?;
            let path=path.to_string_lossy().into_owned();
            let name=path.trim_start_matches("\\\\?\\").trim_end_matches(['\\','/']);
            return Ok(json!({"entry":{"path":path,"parent":path,"name":name,"isDir":true,"extension":"","size":0,"modified":0},"offset":0}));
        }
        let entry=index::Entry::from_path(&path).ok_or("目标已失效、不可访问或成为链接，请重新选择")?;
        if entry.is_dir!=is_dir{return Err("目标类型已改变，请重新选择".into());}
        if entry.is_dir{std::fs::read_dir(&path).map_err(|e|format!("无法访问目录：{e}"))?;}
        let offset=if entry.is_dir{0}else{
            let results=idx.snapshot_search(&Query{root:Some(entry.parent.clone()),..Default::default()});
            let position=results.items.iter().position(|v|v.path==entry.path).ok_or("文件尚未完成索引，请稍后重试")?;
            position/100*100
        };
        Ok(json!({"entry":entry,"offset":offset}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command] async fn search(state:tauri::State<'_,Arc<AppState>>,mut query:Query)->Result<index::Results,String>{
    let idx=state.index.clone();
    tauri::async_runtime::spawn_blocking(move||{
        if let Some(root)=&query.root{query.root=Some(idx.authorize(root)?.to_string_lossy().into_owned());}
        Ok(idx.search(&query))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command] fn index_status(state:tauri::State<Arc<AppState>>)->index::Status{state.index.status.lock().unwrap().clone()}
#[tauri::command] fn reindex(state:tauri::State<Arc<AppState>>){let _=state.index.refresh.send(());}
#[tauri::command] fn save_settings(state:tauri::State<Arc<AppState>>,app:tauri::AppHandle,next:settings::Settings)->Result<settings::Settings,String>{
    let mut current=state.settings.lock().unwrap();
    let search_changed=next.search_enabled!=current.search_enabled||next.search_provider!=current.search_provider||next.deepseek_search_profile_id!=current.deepseek_search_profile_id||next.deepseek_fetch_enabled!=current.deepseek_fetch_enabled||next.assistant_search_limit!=current.assistant_search_limit;
    let needs_test=!current.search_enabled||next.search_provider!=current.search_provider||next.deepseek_search_profile_id!=current.deepseek_search_profile_id||next.deepseek_fetch_enabled&&!current.deepseek_fetch_enabled;
    if next.search_enabled&&needs_test{web_search::ready(&next)?;}
    let next=settings::save(&state.dir,&current,next)?;let roots_changed=next.roots!=current.roots;*current=next.clone();if roots_changed{state.index.configure(&next.roots);}drop(current);if search_changed{network::search_changed(next.search_enabled)?;}assistant_workspace::model_service_changed(&state,&app);Ok(next)
}
#[tauri::command] fn decide_proposal(state:tauri::State<Arc<AppState>>,app:tauri::AppHandle,id:String,approve:bool)->Result<settings::Settings,String>{
    let next=state.proposals.lock().unwrap().remove(&id).ok_or("提案已失效")?;
    if approve {save_settings(state,app,next)}else{Ok(state.settings.lock().unwrap().clone())}
}
#[tauri::command] fn set_key(state:tauri::State<Arc<AppState>>,provider:String,secret:String)->Result<(),String>{
    if !["tavily","deepseek-search","jev"].contains(&provider.as_str()){return Err("模型密钥请在模型连接中测试并保存".into());}
    if provider!="jev"&&!secret.is_empty(){return Err("搜索密钥请通过测试并保存，避免替换有效配置".into());}
    let entry=ai::key(&provider)?;
    if secret.is_empty(){match entry.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>{},Err(e)=>return Err(e.to_string())}}else{entry.set_password(&secret).map_err(|e|e.to_string())?;}
    let active=state.settings.lock().unwrap().clone();
    let current=provider=="tavily"&&active.search_provider=="tavily"||provider=="deepseek-search"&&active.search_provider=="deepseek"&&active.deepseek_search_profile_id.is_none();
    for feature in if provider=="jev"{vec!["jev","ocr_jev"]}else if current{vec!["search","search_fetch","search_test"]}else{vec!["search_test"]}{network::invalidate_feature(feature)?;}Ok(())
}
#[tauri::command] fn import_settings(state:tauri::State<Arc<AppState>>,path:String)->Result<settings::Settings,String>{settings::import(Path::new(&path),&state.settings.lock().unwrap())}
#[tauri::command] fn export_settings(state:tauri::State<Arc<AppState>>,path:String)->Result<(),String>{settings::export(Path::new(&path),&state.settings.lock().unwrap())}
#[tauri::command] async fn open_path(state:tauri::State<'_,Arc<AppState>>,path:String,reveal:bool)->Result<(),String>{
    let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let p=authorize_user_path(&state,&path)?;
        if reveal {let result=shell::reveal(vec![p])?;if let Some(failed)=result["groups"].as_array().and_then(|g|g.iter().find(|g|g["status"]=="failed")){return Err(failed["error"].as_str().unwrap_or("定位失败").into());}return Ok(());
        }open::that_detached(p).map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}
fn authorize_user_path(state:&AppState,path:&str)->Result<std::path::PathBuf,String>{
    state.index.authorize(path).or_else(|error|{
        if assistant_workspace::info(state)["readWrite"]==true{assistant_workspace::authorize_local_path(state,path)}else{Err(error)}
    })
}
#[tauri::command]
async fn drag_file(state:tauri::State<'_,Arc<AppState>>,window:tauri::WebviewWindow,path:String)->Result<Value,String>{
    let state=state.inner().clone();
    let path=tauri::async_runtime::spawn_blocking(move||authorize_user_path(&state,&path)).await.map_err(|e|e.to_string())??;
    #[cfg(windows)] let hwnd=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
    #[cfg(not(windows))] let hwnd=0;
    let (send,result)=tokio::sync::oneshot::channel();
    window.run_on_main_thread(move||{let _=send.send(shell::drag_file(hwnd,path));}).map_err(|e|e.to_string())?;
    result.await.map_err(|_|"系统拖拽已中断，请重试".to_owned())?
}
fn reveal_authorized(state:&AppState,paths:Vec<String>)->Result<Value,String>{let paths=paths.iter().map(|p|authorize_user_path(state,p)).collect::<Result<Vec<_>,_>>()?;shell::reveal(paths)}
#[tauri::command] async fn reveal_paths(state:tauri::State<'_,Arc<AppState>>,paths:Vec<String>)->Result<Value,String>{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||reveal_authorized(&state,paths)).await.map_err(|e|e.to_string())?}
#[tauri::command] async fn launch(state:tauri::State<'_,Arc<AppState>>,id:String,expected_path:Option<String>)->Result<(),String>{
    let path=state.settings.lock().unwrap().launchers.iter().find(|l|l.id==id).map(|l|l.path.clone()).ok_or("工具不存在")?;
    if expected_path.is_some_and(|expected|expected!=path){return Err("工具目标已改变，请从工具列表重新选择".into());}
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
        let value=assistant_workspace::info(&state);let folder=value["path"].as_str().unwrap_or("");
        if path.as_deref().is_some_and(|p|!p.is_empty()&&p!=folder){return Err("会话目录不能授予文件权限，请通过设置选择助理工作目录".into());}
        if open.unwrap_or(false){if folder.is_empty(){return Err("尚未指定助理工作目录".into());}let directory=assistant_fs::Directory::lock(Path::new(folder))?;open::that_detached(&directory.path).map_err(|_|"无法打开助理工作目录".to_string())?;}
        Ok(value)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command] async fn open_report(state:tauri::State<'_,Arc<AppState>>,id:String)->Result<(),String>{let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||assistant_tools::open_report(&state,&id)).await.map_err(|e|e.to_string())?}
#[tauri::command] fn cancel_task(state:tauri::State<Arc<AppState>>,id:String){if let Some(c)=state.tasks.lock().unwrap().get(&id){c.store(true,Ordering::Relaxed);}}
#[tauri::command] fn assistant_budget_proposal(state:tauri::State<Arc<AppState>>)->Result<Value,String>{
    let old=state.settings.lock().unwrap().clone();let next=settings::patch(&old,&json!({"modelRequestTimeoutSecs":old.model_request_timeout_secs.max(600),"assistantTaskTimeoutSecs":old.assistant_task_timeout_secs.max(1800),"modelFirstResponseTimeoutSecs":old.model_first_response_timeout_secs.max(120),"modelIdleTimeoutSecs":old.model_idle_timeout_secs.max(120)}))?;
    let mut p=make_proposal(&state,&old,next);p["reason"]=json!("将不足推荐值的参数提高到：单次请求至少10分钟、整个任务至少30分钟、首响应及停滞等待至少2分钟；已有更长等待时间保留。");p["impact"]=json!("下一次任务可等待更长时间，仍可随时取消；保留当前思考程度，修改仅在确认后生效。");Ok(p)
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
        "translate"=>ai::translate_stream(app.clone(),id.clone(),&settings,&text,language.as_deref().unwrap_or("zh"),cancel.clone()).await,
        "agent"=>{let budget=settings.assistant_task_timeout_secs;let c=cancel.clone();let mut context=context.filter(Value::is_object).unwrap_or(json!({}));context["nativeWorkspaceRevision"]=json!(state.workspace.revision());match tokio::time::timeout(std::time::Duration::from_secs(budget),ai::run_with_pi(state.clone(),text,context,cancel,app.clone(),id.clone())).await{Ok(_) if c.load(Ordering::Relaxed)=>Err("任务已取消".into()),Ok(v)=>v,Err(_)=>{c.store(true,Ordering::Relaxed);Err(format!("任务达到 {budget} 秒总预算"))}}},
        "jev"=>if settings.jev_enabled {ai::jev(&text,items.unwrap_or(json!([])),&cancel).await}else{Err("请先在设置中启用 Jev 实验功能".into())},
        _=>Err("未知任务".into()),
    };
    state.tasks.lock().unwrap().remove(&id);
    state.pi_sessions.lock().unwrap().remove(&id);
    state.workspace.finish(&id);let _=app.emit("assistant-file-approvals-refresh",());
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
            network::init(&dir,app.handle().clone(),!settings.roots.is_empty()||!settings.model_url.is_empty(),settings.search_enabled).map_err(std::io::Error::other)?;
            let (index,rx)=Index::open(&dir).map_err(std::io::Error::other)?;workspace_rename::init(&index).map_err(std::io::Error::other)?;index.configure(&settings.roots);index.clone().spawn(rx);
            let reports=std::fs::read(dir.join("reports.json")).ok().and_then(|data|serde_json::from_slice::<HashMap<String,std::path::PathBuf>>(&data).ok()).unwrap_or_default();
            let ocr_exe=if cfg!(debug_assertions){std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ocr-worker/ocr-worker.exe")}else{app.path().resource_dir()?.join("ocr-worker/ocr-worker.exe")};
            let ocr=match ocr::OcrStore::open(&dir,ocr_exe.clone()){Ok(store)=>store,Err(error)=>{eprintln!("OCR initialization failed: {error}");ocr::OcrStore::disabled(&dir,ocr_exe,error).map_err(std::io::Error::other)?}};
            app.manage(Arc::new(AppState{workspace_renames:workspace_rename::Renames::default(),workspace:assistant_workspace::Workspace::load(&dir),file_previews:file_preview::Previews::default(),dir,ocr,todo_reminders:todo_reminders::TodoReminders::default(),settings:Mutex::new(settings),index,reports:Mutex::new(reports),proposals:Mutex::new(HashMap::new()),tasks:Mutex::new(HashMap::new()),task_results:Mutex::new(HashMap::new()),pi_sessions:Mutex::new(HashMap::new())}));
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
        .invoke_handler(tauri::generate_handler![network::network_status,network::network_decide,network::network_local_mode,network::network_revoke,network::network_clear_activity,network::setup_progress,network::service_status,tavily::tavily_test_connection,web_search::search_test_connection,file_preview::file_preview,file_preview::cancel_file_preview,workspace_rename::workspace_rename_preview,workspace_rename::workspace_rename_apply,workspace_rename::workspace_rename_history,model_profiles::model_test,model_profiles::model_profile_add,model_profiles::model_profile_activate,pi_runtime::pi_step,bootstrap,assistant_documents,save_assistant_document,open_web_url,list_dirs,locate_entry,search,index_status,reindex,save_settings,import_settings,export_settings,decide_proposal,set_key,open_path,drag_file,reveal_paths,launch,reveal_launcher,assistant_workspace,assistant_workspace::assistant_workspace_set,assistant_workspace::assistant_workspace_revoke,assistant_workspace::assistant_workspace_disable_interactive,assistant_workspace::assistant_workspace_prepare,assistant_workspace::assistant_workspace_confirm,assistant_workspace::assistant_workspace_audit,assistant_workspace::assistant_workspace_pending,assistant_workspace::assistant_workspace_decide,open_report,cancel_task,task_status,assistant_context,delete_assistant_session,assistant_budget_proposal,ai_task,get_todos,save_todos,get_todo_reminder_status,todo_ai_assist,ocr::ocr_bootstrap,ocr::ocr_preview_sample,ocr::ocr_save_profile,ocr::ocr_delete_profile,ocr::ocr_import_profiles,ocr::ocr_generate_profile,ocr::ocr_import_files,ocr::ocr_get_task,ocr::ocr_start_task,ocr::ocr_resume_workflow,ocr::ocr_cancel_task,ocr::ocr_delete_task,ocr::ocr_clear_completed_tasks,ocr::ocr_update_result,ocr::ocr_preview_rename,ocr::ocr_apply_rename,ocr::ocr_export,ocr::ocr_open_file,ocr::ocr_export_profile])
        .run(tauri::generate_context!()).expect("MultiTool Office failed to start");
}
