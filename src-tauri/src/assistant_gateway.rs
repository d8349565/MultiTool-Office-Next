use crate::{AppState, assistant_context::TaskContext};
use serde_json::Value;

#[derive(Clone,Copy,Debug,PartialEq)]
pub enum Capability { Metadata, AppState, PublicSearch, Artifact, SettingsProposal, UserAction, Control }
pub fn capability(tool:&str)->Result<Capability,String>{
    Ok(match tool{
        "files_query"|"resultset_enrich"|"directory_tree"|"files_search"|"files_analyze"|"files_list_dirs"|"files_missing_companion"=>Capability::Metadata,
        "settings_read"|"app_get_state"=>Capability::AppState,
        "web_search"=>Capability::PublicSearch,
        "report_create"=>Capability::Artifact,
        "settings_propose_change"=>Capability::SettingsProposal,
        "files_reveal"|"path_open"|"launcher_run"|"clipboard_copy"|"index_refresh"|"text_translate"=>Capability::UserAction,
        "task_clarify"=>Capability::Control,
        _=>return Err("工具不存在或未授权".into()),
    })
}
pub fn check(state:&AppState,current:&TaskContext,tool:&str,args:&Value,respond_only:bool)->Result<(),String>{
    let capability=capability(tool)?;
    if respond_only{return Err("本轮只整理已有资料，不允许新工具操作".into());}
    if capability==Capability::UserAction&&!current.intent.allowed_actions.iter().any(|t|t==tool){return Err("本轮用户没有授权该外部操作".into());}
    if capability==Capability::Artifact&&current.intent.delivery!="html"&&current.intent.operation!="report"{return Err("用户没有要求创建报告".into());}
    if tool=="files_search"&&args["query"].as_str().is_none_or(|q|q.trim().is_empty()){return Err("关键词搜索需要非空关键词；查询范围内全部项目请使用 files_query".into());}
    if capability==Capability::Metadata{
        for key in ["root","path"]{if let Some(path)=args[key].as_str(){let p=state.index.authorize(path)?;
            if current.intent.root.as_ref().is_some_and(|root|!p.starts_with(root)){return Err("工具范围超过本轮已确定目录，请先明确更新任务范围".into());}
        }}
        if let Some(id)=args["resultSetId"].as_str(){crate::assistant_context::evidence(state,&current.session_id,id)?;}
    }
    if capability==Capability::PublicSearch&&!state.settings.lock().unwrap().tavily_enabled{return Err("请先在设置中启用 Tavily 联网搜索".into());}
    if capability==Capability::SettingsProposal&&tool=="settings_propose_change"{crate::settings::patch(&state.settings.lock().unwrap(),&args["changes"])?;}
    if tool=="path_open"{state.index.authorize(args["path"].as_str().ok_or("缺少路径")?)?;}
    if tool=="files_reveal"{for path in args["paths"].as_array().ok_or("缺少路径集合")?{state.index.authorize(path.as_str().ok_or("路径无效")?)?;}}
    Ok(())
}
