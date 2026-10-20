use crate::{AppState, assistant_context::TaskContext};
use serde_json::Value;

#[derive(Clone,Copy,Debug,PartialEq)]
pub enum Capability { Metadata, AppState, PublicSearch, Artifact, WorkspaceFile, SettingsProposal, UserAction, Control }
pub fn capability(tool:&str)->Result<Capability,String>{
    Ok(match tool{
        "files_query"|"resultset_enrich"|"directory_tree"|"files_search"|"files_analyze"|"files_list_dirs"|"files_missing_companion"=>Capability::Metadata,
        "settings_read"|"app_get_state"|"pricing_read"=>Capability::AppState,
        "web_search"|"web_fetch"=>Capability::PublicSearch,
        "report_create"=>Capability::Artifact,
        "workspace_list_files"|"workspace_read_file"|"document_create"|"spreadsheet_translate"|"html_app_create"=>Capability::WorkspaceFile,
        "settings_propose_change"|"pricing_propose_change"|"model_config_add"=>Capability::SettingsProposal,
        "files_reveal"|"path_open"|"launcher_run"|"clipboard_copy"|"index_refresh"|"text_translate"=>Capability::UserAction,
        "task_clarify"=>Capability::Control,
        _=>return Err("工具不存在或未授权".into()),
    })
}
pub fn check_scope(scope:&str,tool:&str)->Result<(),String>{
    if scope=="assistant"&&capability(tool)?==Capability::Metadata{return Err("本轮范围是助理文件夹，不能查询文件管理目录或业务索引；请使用 workspace_list_files 和 workspace_read_file，未设置或未授权时说明设置位置，不回退到其他目录".into());}Ok(())
}
pub fn check(state:&AppState,current:&TaskContext,tool:&str,args:&Value,respond_only:bool)->Result<(),String>{
    let capability=capability(tool)?;
    if respond_only{return Err("本轮只整理已有资料，不允许新工具操作".into());}
    check_scope(&current.intent.scope,tool)?;
    if capability==Capability::UserAction&&!current.intent.allowed_actions.iter().any(|t|t==tool){return Err("本轮用户没有授权该外部操作".into());}
    if capability==Capability::Artifact&&current.intent.delivery!="html"&&current.intent.operation!="report"{return Err("用户没有要求创建报告".into());}
    if matches!(capability,Capability::WorkspaceFile|Capability::Artifact){crate::assistant_workspace::authorize(state,current.workspace_revision)?;}
    if tool=="html_app_create"{if current.intent.operation!="document"||current.intent.delivery!="file"{return Err("只有用户要求制作并保存文件时才能生成交互网页".into());}crate::assistant_workspace::authorize_interactive(state,current.workspace_revision)?;}
    if tool=="files_search"&&args["query"].as_str().is_none_or(|q|q.trim().is_empty()){return Err("关键词搜索需要非空关键词；查询范围内全部项目请使用 files_query".into());}
    if capability==Capability::Metadata{
        for key in ["root","path"]{if let Some(path)=args[key].as_str(){let p=state.index.authorize(path)?;
            if current.intent.root.as_ref().is_some_and(|root|!p.starts_with(root)){return Err("工具范围超过本轮已确定目录，请先明确更新任务范围".into());}
        }}
        if let Some(id)=args["resultSetId"].as_str(){crate::assistant_context::evidence(state,&current.session_id,id)?;}
    }
    if capability==Capability::PublicSearch{
        let s=state.settings.lock().unwrap();
        if !s.search_enabled||s.assistant_search_limit==0{return Err("请先在设置中启用联网搜索并配置任务次数上限".into());}
        if tool=="web_fetch"&&(s.search_provider!="deepseek"||!s.deepseek_fetch_enabled){return Err("额外网页正文抓取尚未开启".into());}
    }
    if capability==Capability::PublicSearch&&current.has_workspace_file_data{return Err("本会话已接触本地工作目录资料，禁止把它们带入公开搜索；需要搜索公开资料请新建会话".into());}
    if capability==Capability::SettingsProposal&&tool=="settings_propose_change"{crate::settings::patch(&state.settings.lock().unwrap(),&args["changes"])?;}
    if tool=="pricing_propose_change"{crate::settings::patch(&state.settings.lock().unwrap(),&serde_json::json!({"modelPricing":args["pricing"]}))?;}
    if tool=="model_config_add"&&current.intent.operation!="config"{return Err("只有用户要求配置模型接口时才能新增模型配置".into());}
    if tool=="path_open"{authorize_action_path(state,current,args["path"].as_str().ok_or("缺少路径")?)?;}
    if tool=="files_reveal"{for path in args["paths"].as_array().ok_or("缺少路径集合")?{authorize_action_path(state,current,path.as_str().ok_or("路径无效")?)?;}}
    Ok(())
}
fn authorize_action_path(state:&AppState,current:&TaskContext,path:&str)->Result<(),String>{
    if current.intent.scope=="assistant"{crate::assistant_workspace::authorize(state,current.workspace_revision)?;crate::assistant_workspace::authorize_local_path(state,path)?;}else{crate::authorize_user_path(state,path)?;}Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn assistant_scope_rejects_all_business_index_tools(){
        for tool in ["files_query","resultset_enrich","directory_tree","files_search","files_analyze","files_list_dirs","files_missing_companion"]{assert!(check_scope("assistant",tool).is_err());assert!(check_scope("current",tool).is_ok());}
        for tool in ["workspace_list_files","workspace_read_file","document_create","spreadsheet_translate","path_open","files_reveal","task_clarify"]{assert!(check_scope("assistant",tool).is_ok());}
    }
}
