use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, future::Future, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

static NETWORK: OnceLock<Network> = OnceLock::new();
const RETENTION: u64 = 30 * 86400;

#[derive(Clone, Copy)]
pub enum Feature { Assistant, Translation, Todo, OcrConfig, OcrJev, Jev, ModelTest, Search, SearchTest, Fetch }
impl Feature {
    fn info(self) -> (&'static str, &'static str, Vec<&'static str>, bool) {
        match self {
            Self::Assistant => ("assistant", "AI 助手", vec!["对话与角色设定", "工作目录上下文、文件名和路径", "工具结果及经逐文件确认的正文", "用户主动提交的图片（可能随追问再次发送）"], false),
            Self::Translation => ("translation", "翻译", vec!["用户提交的翻译文字"], false),
            Self::Todo => ("todo", "待办辅助", vec!["相关待办、灵感和辅助输入"], false),
            Self::OcrConfig => ("ocr_config", "AI 生成 OCR 配置", vec!["配置需求、提取字段和规则（不读取样本文档）"], false),
            Self::OcrJev => ("ocr_jev", "OCR 联网辅助", vec!["过滤金额和长号码后的候选文本、字段判断说明"], true),
            Self::Jev => ("jev", "文件候选评分", vec!["任务文字、候选名称和相对路径"], false),
            Self::ModelTest => ("model_test", "模型连接测试", vec!["固定测试消息和工具定义（不执行工具）"], false),
            Self::Search => ("search", "Tavily 联网搜索", vec!["公开搜索关键词（搜索摘要还会交给当前模型）"], false),
            Self::SearchTest => ("search_test", "Tavily 连接测试", vec!["固定公开关键词 Microsoft WebView2"], false),
            Self::Fetch => ("search_fetch", "DeepSeek 网页正文抓取", vec!["公开网页网址（获取的正文还会交给当前模型）"], false),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Grant { id:String, feature:String, label:String, service:String, categories:Vec<String>, masked:bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Activity { id:String, time:u64, feature:String, label:String, service:String, categories:Vec<String>, masked:bool, status:String, #[serde(default,skip_serializing_if="Option::is_none")] billing:Option<Value> }
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all="camelCase")]
struct Data { local_only:bool, setup_step:u8, setup_dismissed:bool, grants:Vec<Grant>, activities:Vec<Activity>, tavily_tested_at:Option<u64>, tavily_binding:String, search_tests:HashMap<String,u64> }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Consent { id:String, grant:Grant, expires_at:u64 }
struct Pending { consent:Consent, replies:Vec<oneshot::Sender<bool>> }
struct Network { path:PathBuf, app:tauri::AppHandle, data:Mutex<Data>, pending:Mutex<HashMap<String,Pending>>, active:Mutex<HashMap<String,(String,Arc<AtomicBool>)>>, search_enabled:AtomicBool, notice:Option<String> }
fn now()->u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn network()->Result<&'static Network,String>{NETWORK.get().ok_or("联网控制尚未初始化".into())}
fn prune(data:&mut Data){data.activities.retain(|a|a.time.saturating_add(RETENTION)>now());if data.activities.len()>1000{data.activities.drain(..data.activities.len()-1000);}}
impl Network {
    fn announce(&self){let _=self.app.emit("network-updated",());}
    fn edit(&self,change:impl FnOnce(&mut Data))->Result<(),String>{
        let mut data=self.data.lock().unwrap();let previous=data.clone();change(&mut data);prune(&mut data);
        if let Err(error)=crate::settings::atomic_write(&self.path,&serde_json::to_vec_pretty(&*data).map_err(|_|"联网设置序列化失败")?){*data=previous;return Err(error);}
        drop(data);self.announce();Ok(())
    }
    fn allowed(&self,grant:&Grant)->bool{let data=self.data.lock().unwrap();!data.local_only&&data.grants.iter().any(|g|g.id==grant.id&&g.categories==grant.categories)}
    fn cancel(&self,id:Option<&str>){
        for (_, (binding,cancel)) in self.active.lock().unwrap().iter(){if id.is_none_or(|id|binding==id){cancel.store(true,Ordering::Relaxed);}}
        let mut pending=self.pending.lock().unwrap();let ids:Vec<_>=pending.iter().filter(|(_,p)|id.is_none_or(|id|p.consent.grant.id==id)).map(|(id,_)|id.clone()).collect();
        for id in ids{if let Some(p)=pending.remove(&id){for reply in p.replies{let _=reply.send(false);}}}drop(pending);self.announce();
    }
}
pub fn init(dir:&std::path::Path,app:tauri::AppHandle,existing_user:bool,search_enabled:bool)->Result<(),String>{
    let path=dir.join("network-policy.json");
    let mut notice=None;
    let mut data=if path.exists(){match std::fs::read(&path).ok().and_then(|bytes|serde_json::from_slice::<Data>(&bytes).ok()){
        Some(data)=>data,
        None=>{std::fs::copy(&path,dir.join(format!("network-policy.unreadable-{}.json",uuid::Uuid::new_v4()))).map_err(|_|"联网控制设置无法读取，且无法保留恢复副本")?;notice=Some("联网设置无法读取，已保留恢复副本并切换为仅本地模式。请重新检查联网授权。".into());Data{local_only:true,setup_dismissed:existing_user,..Default::default()}}
    }}else{Data{setup_dismissed:existing_user,..Default::default()}};
    for a in &mut data.activities{if a.status=="running"{a.status="interrupted".into();}}prune(&mut data);
    crate::settings::atomic_write(&path,&serde_json::to_vec_pretty(&data).map_err(|_|"联网设置序列化失败")?)?;
    NETWORK.set(Network{path,app,data:Mutex::new(data),pending:Mutex::new(HashMap::new()),active:Mutex::new(HashMap::new()),search_enabled:AtomicBool::new(search_enabled),notice}).map_err(|_|"联网控制重复初始化".into())
}
fn grant(feature:Feature,url:&str,secret:&str,binding:&str)->Result<Grant,String>{
    let parsed=reqwest::Url::parse(url).map_err(|_|"联网服务地址无效")?;
    let (id,label,categories,masked)=feature.info();
    // 只保存不可逆的服务/账号绑定摘要，不保存密钥、完整接口路径或请求正文。
    let mut hash=Sha256::new();for part in [id,url,secret,binding]{hash.update((part.len() as u64).to_le_bytes());hash.update(part.as_bytes());}
    let label=if matches!(feature,Feature::Search|Feature::SearchTest)&&parsed.host_str()==Some("api.deepseek.com"){if matches!(feature,Feature::SearchTest){"DeepSeek 连接测试"}else{"DeepSeek 联网搜索"}}else{label};
    Ok(Grant{id:format!("{:x}",hash.finalize()),feature:id.into(),label:label.into(),service:parsed.origin().ascii_serialization(),categories:categories.into_iter().map(String::from).collect(),masked})
}
fn current_search(feature:Feature,url:&str,secret:&str,binding:&str)->Result<(),String>{
    if !matches!(feature,Feature::Search|Feature::Fetch){return Ok(());}
    let state=network()?.app.try_state::<Arc<crate::AppState>>().ok_or("工作台尚未初始化")?;
    let settings=state.settings.lock().unwrap().clone();
    crate::web_search::check_connection(&settings,feature,url,secret,binding)
}
pub async fn authorize(feature:Feature,url:&str,secret:&str,binding:&str,cancel:&AtomicBool)->Result<(),String>{
    let net=network()?;let grant=grant(feature,url,secret,binding)?;
    if matches!(feature,Feature::Search|Feature::Fetch)&&!net.search_enabled.load(Ordering::Relaxed){return Err("联网搜索已关闭，请在设置中主动启用".into());}
    current_search(feature,url,secret,binding)?;
    if cancel.load(Ordering::Relaxed){return Err("任务已取消".into());}
    if net.allowed(&grant){return Ok(());}
    if net.data.lock().unwrap().local_only{return Err("仅本地模式已开启；请在隐私与联网设置中关闭后再使用此功能".into());}
    let (sender,receiver)=oneshot::channel();
    {
        let mut pending=net.pending.lock().unwrap();
        pending.retain(|_,p|p.consent.expires_at>now()&&p.replies.iter().any(|r|!r.is_closed()));
        if let Some(p)=pending.values_mut().find(|p|p.consent.grant.id==grant.id){p.replies.push(sender);}else{let id=uuid::Uuid::new_v4().to_string();pending.insert(id.clone(),Pending{consent:Consent{id,grant:grant.clone(),expires_at:now()+90},replies:vec![sender]});}
    }
    if net.data.lock().unwrap().local_only{net.cancel(None);return Err("仅本地模式已开启，未发送请求".into());}
    net.announce();
    let approved=tokio::select!{r=receiver=>r.unwrap_or(false),_=tokio::time::sleep(Duration::from_secs(90))=>false,_=wait(cancel)=>false};
    net.pending.lock().unwrap().retain(|_,p|p.consent.expires_at>now()&&p.replies.iter().any(|r|!r.is_closed()));net.announce();
    if approved&&net.allowed(&grant)&&!cancel.load(Ordering::Relaxed){Ok(())}else{Err("本次联网未获授权、已撤销或确认超时；未继续发送".into())}
}
pub async fn wait(cancel:&AtomicBool){while !cancel.load(Ordering::Relaxed){tokio::time::sleep(Duration::from_millis(50)).await;}}
pub fn request_categories(feature:Feature,body:&Value)->Vec<String>{
    if !matches!(feature,Feature::Assistant){return feature.info().2.into_iter().map(String::from).collect();}
    let mut categories=vec!["对话与任务上下文".into()];
    let messages=body["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if messages.iter().any(|m|m["role"]=="system"){categories.push("系统设定".into());}
    static PATH_PATTERN:OnceLock<regex::Regex>=OnceLock::new();
    let path=PATH_PATTERN.get_or_init(||regex::Regex::new(r"(?i)([a-z]:[\\/]|\\\\|/Users/|/home/)").unwrap());
    if messages.iter().any(|m|m["content"].as_str().is_some_and(|text|path.is_match(text))){categories.push("文件名与路径上下文".into());}
    if messages.iter().any(|m|m["role"]=="tool"){categories.push("工具返回结果".into());}
    if messages.iter().filter(|m|m["role"]=="tool").any(|m|m["content"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()).is_some_and(|v|v["filename"].is_string()&&v["text"].is_string())){categories.push("经逐文件确认的文件正文".into());}
    if messages.iter().any(|m|m["content"].as_array().is_some_and(|parts|parts.iter().any(|p|p["type"]=="image_url"))){categories.push("用户提交的图片".into());}
    categories
}
struct Running { id:String, finished:bool }
impl Running {
    fn finish(&mut self,status:&str){if let Ok(net)=network(){let _=net.edit(|d|{if let Some(a)=d.activities.iter_mut().find(|a|a.id==self.id){a.status=status.into();}});net.active.lock().unwrap().remove(&self.id);}self.finished=true;}
}
impl Drop for Running{fn drop(&mut self){if !self.finished{self.finish("interrupted");}}}
pub async fn request<T>(feature:Feature,url:&str,secret:&str,binding:&str,cancel:&AtomicBool,categories:Vec<String>,future:impl Future<Output=Result<T,String>>)->Result<T,String>{
    request_with_id(feature,url,secret,binding,cancel,categories,None,future).await
}
pub async fn request_with_id<T>(feature:Feature,url:&str,secret:&str,binding:&str,cancel:&AtomicBool,categories:Vec<String>,request_id:Option<&str>,future:impl Future<Output=Result<T,String>>)->Result<T,String>{
    let net=network()?;let grant=grant(feature,url,secret,binding)?;
    if let Err(error)=authorize(feature,url,secret,binding,cancel).await{let _=net.edit(|d|d.activities.push(Activity{id:uuid::Uuid::new_v4().to_string(),time:now(),feature:grant.feature.clone(),label:grant.label.clone(),service:grant.service.clone(),categories,masked:grant.masked,status:"blocked".into(),billing:None}));return Err(error);}
    let revoked=Arc::new(AtomicBool::new(false));let id=request_id.map(str::to_owned).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    // 先登记，再重查权限，封住授权撤销与开始发送之间的竞态。
    net.active.lock().unwrap().insert(id.clone(),(grant.id.clone(),revoked.clone()));
    let mut running=Running{id:id.clone(),finished:false};
    net.edit(|d|d.activities.push(Activity{id,time:now(),feature:grant.feature.clone(),label:grant.label.clone(),service:grant.service.clone(),categories,masked:grant.masked,status:"running".into(),billing:None}))?;
    if !net.allowed(&grant)||revoked.load(Ordering::Relaxed){running.finish("blocked");return Err("联网权限已撤销，未发送请求".into());}
    if let Err(error)=current_search(feature,url,secret,binding){running.finish("blocked");return Err(error);}
    let result=tokio::select!{r=future=>r,_=wait(&revoked)=>Err("联网权限已撤销，已停止当前请求".into()),_=wait(cancel)=>Err("任务已取消".into())};
    running.finish(if result.is_ok(){"success"}else if revoked.load(Ordering::Relaxed)||cancel.load(Ordering::Relaxed){"cancelled"}else{"failed"});result
}
pub fn model_binding(s:Option<&crate::settings::Settings>)->String{s.map(|s|format!("{}:{}:{}",s.active_model_profile_id.as_deref().unwrap_or("legacy"),s.model_connection_revision,s.model_id)).unwrap_or_default()}
pub fn invalidate_feature(feature:&str)->Result<(),String>{let net=network()?;let mut ids:Vec<_>=net.data.lock().unwrap().grants.iter().filter(|g|g.feature==feature).map(|g|g.id.clone()).collect();ids.extend(net.pending.lock().unwrap().values().filter(|p|p.consent.grant.feature==feature).map(|p|p.consent.grant.id.clone()));net.edit(|d|d.grants.retain(|g|g.feature!=feature))?;for id in ids{net.cancel(Some(&id));}Ok(())}
pub fn search_changed(enabled:bool)->Result<(),String>{network()?.search_enabled.store(enabled,Ordering::Relaxed);invalidate_feature("search")?;invalidate_feature("search_fetch")?;invalidate_feature("search_test")?;Ok(())}
pub fn record_service_usage(record:&Value)->Result<(),String>{network()?.edit(|d|{if let Some(a)=d.activities.iter_mut().find(|a|Some(a.id.as_str())==record["id"].as_str()){a.billing=Some(record.clone());}})}
pub fn search_tested(provider:&str,secret:&str,binding:&str)->Result<u64,String>{
    if provider=="tavily"{return tavily_tested(secret);}
    let stamp=now();let id=grant(Feature::SearchTest,crate::web_search::SEARCH_URL,secret,binding)?.id;
    network()?.edit(|d|{d.search_tests.insert(id,stamp);if d.search_tests.len()>100{if let Some(old)=d.search_tests.iter().min_by_key(|(_,time)|**time).map(|(id,_)|id.clone()){d.search_tests.remove(&old);}}})?;Ok(stamp)
}
pub fn search_tested_at(provider:&str,secret:&str,binding:&str)->Option<u64>{
    let id=grant(Feature::SearchTest,if provider=="deepseek"{crate::web_search::SEARCH_URL}else{"https://api.tavily.com/search"},secret,binding).ok()?.id;
    let data=network().ok()?.data.lock().ok()?;
    if provider=="tavily"{if id==data.tavily_binding{data.tavily_tested_at}else{None}}else{data.search_tests.get(&id).copied()}
}
pub fn tavily_tested(secret:&str)->Result<u64,String>{let stamp=now();let id=grant(Feature::SearchTest,"https://api.tavily.com/search",secret,"")?.id;network()?.edit(|d|{d.tavily_tested_at=Some(stamp);d.tavily_binding=id;})?;Ok(stamp)}

#[tauri::command]
pub fn network_status()->Result<Value,String>{let net=network()?;let mut data=net.data.lock().unwrap();let count=data.activities.len();prune(&mut data);if count!=data.activities.len(){crate::settings::atomic_write(&net.path,&serde_json::to_vec_pretty(&*data).map_err(|_|"活动记录序列化失败")?)?;}let mut pending=net.pending.lock().unwrap();pending.retain(|_,p|p.consent.expires_at>now()&&p.replies.iter().any(|r|!r.is_closed()));let mut consents:Vec<_>=pending.values().map(|p|p.consent.clone()).collect();consents.sort_by_key(|p|p.expires_at);Ok(json!({"localOnly":data.local_only,"setupStep":data.setup_step,"setupDismissed":data.setup_dismissed,"grants":data.grants,"activities":data.activities.iter().rev().collect::<Vec<_>>(),"pending":consents,"notice":net.notice}))}
#[tauri::command]
pub fn network_decide(id:String,approve:bool)->Result<(),String>{let net=network()?;let p=net.pending.lock().unwrap().remove(&id).ok_or("此联网确认已结束")?;let approved=approve&&p.consent.expires_at>now()&&p.replies.iter().any(|r|!r.is_closed())&&!net.data.lock().unwrap().local_only;if approved{let grant=p.consent.grant;net.edit(|d|{d.grants.retain(|g|g.id!=grant.id);d.grants.push(grant);})?;}for reply in p.replies{let _=reply.send(approved);}net.announce();Ok(())}
#[tauri::command]
pub fn network_local_mode(enabled:bool)->Result<(),String>{let net=network()?;net.edit(|d|d.local_only=enabled)?;if enabled{net.cancel(None);}Ok(())}
#[tauri::command]
pub fn network_revoke(id:String)->Result<(),String>{let net=network()?;net.edit(|d|d.grants.retain(|g|g.id!=id))?;net.cancel(Some(&id));Ok(())}
#[tauri::command]
pub fn network_clear_activity()->Result<(),String>{network()?.edit(|d|d.activities.retain(|a|a.status=="running"))}
#[tauri::command]
pub fn setup_progress(step:u8,dismissed:bool)->Result<(),String>{if step>3{return Err("引导步骤无效".into());}network()?.edit(|d|{d.setup_step=step;d.setup_dismissed=dismissed;})}
#[tauri::command]
pub fn service_status(state:tauri::State<Arc<crate::AppState>>,search_provider:Option<String>,profile_id:Option<String>)->Result<Value,String>{
    let s=state.settings.lock().unwrap().clone();
    let has=|provider:&str|crate::ai::key(provider).and_then(|k|k.get_password().map_err(|_|"无法读取凭据".to_string())).ok().filter(|v|!v.trim().is_empty());
    let model=has(&crate::model_profiles::credential(s.active_model_profile_id.as_deref())).is_some();
    let tavily=has("tavily");
    let provider=search_provider.as_deref().unwrap_or(&s.search_provider);
    let profile=match profile_id.as_deref(){Some("")=>None,Some(id)=>Some(id),None=>s.deepseek_search_profile_id.as_deref()};
    let credentials=crate::web_search::credential(&s,provider,profile).ok();
    let tested=credentials.as_ref().and_then(|(key,binding)|search_tested_at(provider,key,binding));
    let profiles:Vec<_>=crate::model_profiles::profiles(&s).into_iter().filter(|p|crate::web_search::official_deepseek(&p.model_url)&&has(&crate::model_profiles::credential(Some(&p.id))).is_some()).map(|p|json!({"id":p.id,"name":p.name})).collect();
    Ok(json!({"modelKey":model,"modelConfigured":model&&!s.model_url.is_empty()&&!s.model_id.is_empty(),"tavilyKey":tavily.is_some(),"tavilyTestedAt":tavily.as_ref().and_then(|key|search_tested_at("tavily",key,"")),"searchEnabled":s.search_enabled,"searchProvider":provider,"searchProfileId":if provider=="deepseek"{profile}else{None},"searchKey":credentials.is_some(),"searchTestedAt":tested,"deepseekOwnKey":has("deepseek-search").is_some(),"deepseekProfiles":profiles,"jevKey":has("jev").is_some()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consent_is_bound_to_account_service_feature_and_profile_without_storing_secrets(){
        let original=grant(Feature::Assistant,"https://example.com/v1/chat/completions","test-key-one","profile-one").unwrap();
        for different in [
            grant(Feature::Assistant,"https://example.com/other/chat/completions","test-key-one","profile-one"),
            grant(Feature::Assistant,"https://example.com/v1/chat/completions","test-key-two","profile-one"),
            grant(Feature::Assistant,"https://example.com/v1/chat/completions","test-key-one","profile-two"),
            grant(Feature::Translation,"https://example.com/v1/chat/completions","test-key-one","profile-one"),
        ]{assert_ne!(original.id,different.unwrap().id);}
        let saved=serde_json::to_string(&original).unwrap();assert!(!saved.contains("test-key-one"));assert!(!saved.contains("/v1/chat/completions"));
    }
    #[test]
    fn assistant_activity_does_not_claim_images_or_document_content_for_a_plain_question(){
        let plain=request_categories(Feature::Assistant,&json!({"messages":[{"role":"user","content":"普通问题"}]}));
        assert_eq!(plain,vec!["对话与任务上下文"]);
        let document=request_categories(Feature::Assistant,&json!({"messages":[{"role":"tool","content":"{\"filename\":\"example.txt\",\"text\":\"private sample content\"}"}]}));
        assert!(document.iter().any(|c|c=="经逐文件确认的文件正文"));assert!(!document.join(" ").contains("private sample content"));
    }
}
