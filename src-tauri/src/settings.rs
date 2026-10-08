use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launcher { pub id: String, pub name: String, pub path: String, pub group: String }

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u32, pub revision: u64, pub roots: Vec<String>, pub theme: String,
    pub recursive: bool, pub filter: String, pub launchers: Vec<Launcher>,
    pub model_url: String, pub model_id: String, pub jev_enabled: bool,
    #[serde(default)] pub tavily_enabled: bool,
    #[serde(default="default_reasoning")] pub assistant_reasoning: String,
    #[serde(default="default_reasoning")] pub translation_reasoning: String,
    #[serde(default)] pub model_context_tokens: u32,
    #[serde(default)] pub assistant_output_tokens: u32,
    #[serde(default)] pub translation_output_tokens: u32,
    #[serde(default="default_request_timeout")] pub model_request_timeout_secs: u64,
    #[serde(default="default_request_timeout")] pub model_first_response_timeout_secs: u64,
    #[serde(default="default_idle_timeout")] pub model_idle_timeout_secs: u64,
    #[serde(default="default_retry_count")] pub model_retry_count: u32,
    #[serde(default="default_task_timeout")] pub assistant_task_timeout_secs: u64,
    #[serde(default="default_history_messages")] pub assistant_history_messages: usize,
    #[serde(default="default_history_chars")] pub assistant_history_chars: usize,
    #[serde(default="default_tool_rounds")] pub assistant_tool_rounds: u32,
    #[serde(default="default_search_limit")] pub assistant_search_limit: usize,
    #[serde(default="default_auto_continue")] pub assistant_auto_continue: bool,
    #[serde(default="default_continue_tokens")] pub assistant_continue_tokens: u32,
    #[serde(default)] pub model_temperature: Option<f64>,
    #[serde(default)] pub model_top_p: Option<f64>,
    #[serde(default)] pub model_pricing: crate::pricing::PricingConfig,

}
fn default_request_timeout()->u64{45}
fn default_idle_timeout()->u64{60}
fn default_retry_count()->u32{2}
fn default_task_timeout()->u64{180}
fn default_history_messages()->usize{12}
fn default_history_chars()->usize{4000}
fn default_tool_rounds()->u32{25}
fn default_search_limit()->usize{8}
fn default_auto_continue()->bool{true}
fn default_continue_tokens()->u32{16384}
fn default_reasoning()->String{"default".into()}
impl Default for Settings {
    fn default() -> Self { Self { schema_version: 1, revision: 0, roots: vec![], theme: "light".into(), recursive: true, filter: String::new(), launchers: vec![], model_url: String::new(), model_id: String::new(), jev_enabled: false, tavily_enabled: false, assistant_reasoning: "max".into(), translation_reasoning: default_reasoning(), model_context_tokens: 0, assistant_output_tokens: 0, translation_output_tokens: 0, model_request_timeout_secs: 300, model_first_response_timeout_secs:45, model_idle_timeout_secs:60, model_retry_count: default_retry_count(), assistant_task_timeout_secs: 600, assistant_history_messages: default_history_messages(), assistant_history_chars: default_history_chars(), assistant_tool_rounds: default_tool_rounds(), assistant_search_limit: default_search_limit(), assistant_auto_continue: default_auto_continue(), assistant_continue_tokens: default_continue_tokens(), model_temperature: None, model_top_p: None, model_pricing: Default::default() } }
}
#[derive(Debug, PartialEq)]
pub enum LauncherTarget { Local(PathBuf), Web(String) }
pub fn launcher_target(raw: &str) -> Result<LauncherTarget, String> {
    let target=raw.trim();
    let lower=target.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        let url=reqwest::Url::parse(target).map_err(|_|"网页入口地址无效")?;
        if !matches!(url.scheme(),"http"|"https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            return Err("网页入口需要不含账号密码的 HTTP 或 HTTPS 地址".into());
        }
        return Ok(LauncherTarget::Web(url.to_string()));
    }
    if Path::new(target).is_absolute() { return Ok(LauncherTarget::Local(PathBuf::from(target))); }
    Err("工具目标需要本地绝对路径，或以 http://、https:// 开头的网页地址".into())
}
pub fn validate(s: &Settings) -> Result<(), String> {
    crate::pricing::validate(&s.model_pricing)?;
    if s.schema_version != 1 { return Err("不支持的配置版本".into()); }
    if !["light", "dark", "system"].contains(&s.theme.as_str()) { return Err("无效主题".into()); }
    for effort in [&s.assistant_reasoning,&s.translation_reasoning] {if !["default","none","minimal","low","medium","high","xhigh","max","ultra"].contains(&effort.to_ascii_lowercase().as_str()){return Err("无效思考程度".into());}}
    if s.model_context_tokens>10_000_000{return Err("模型上下文容量不能超过 10000000".into());}
    for tokens in [s.assistant_output_tokens,s.translation_output_tokens]{if tokens!=0 && !(256..=384000).contains(&tokens){return Err("输出上限应为 256–384000，或使用 0 自动选择".into());}}
    if !(256..=384000).contains(&s.assistant_continue_tokens){return Err("补写输出上限应为 256–384000".into());}
    if !(10..=600).contains(&s.model_request_timeout_secs) || !(30..=1800).contains(&s.assistant_task_timeout_secs) || s.assistant_task_timeout_secs<s.model_request_timeout_secs{return Err("请求等待应为 10–600 秒，任务等待应为 30–1800 秒，且不小于请求等待".into());}
    if !(10..=600).contains(&s.model_first_response_timeout_secs) || !(10..=600).contains(&s.model_idle_timeout_secs){return Err("首响应与停滞等待应为 10–600 秒".into());}
    if s.model_retry_count>5 || s.assistant_history_messages>12 || !(500..=12000).contains(&s.assistant_history_chars) || !(1..=25).contains(&s.assistant_tool_rounds) || s.assistant_search_limit>20{return Err("重试、历史上下文或工具调用限制超出允许范围".into());}
    if s.model_temperature.is_some_and(|v|!v.is_finite() || !(0.0..=2.0).contains(&v)) || s.model_top_p.is_some_and(|v|!v.is_finite() || !(0.01..=1.0).contains(&v)){return Err("温度应为 0–2，采样范围应为 0.01–1，或留空使用模型默认".into());}
    if s.roots.len() > 100 || s.filter.len() > 500 { return Err("目录或筛选条件过多".into()); }
    for root in &s.roots { if !Path::new(root).is_absolute() { return Err("搜索目录必须使用绝对路径".into()); } }
    let mut ids = std::collections::HashSet::new();
    for item in &s.launchers {
        if item.id.trim().is_empty() || item.name.trim().is_empty() || !ids.insert(&item.id) { return Err("工具需要非空的唯一 ID 和名称".into()); }
        launcher_target(&item.path).map_err(|e|format!("工具“{}”：{e}",item.name))?;
    }
    if !s.model_url.is_empty() {
        let u = reqwest::Url::parse(&s.model_url).map_err(|_| "模型地址无效")?;
        if u.scheme() != "https" && !(u.scheme() == "http" && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))) { return Err("远程模型地址必须使用 HTTPS".into()); }
        if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() { return Err("地址不得包含凭据、查询参数或片段".into()); }
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无效保存目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).and_then(|_| temp.as_file().sync_all()).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load(dir: &Path) -> Result<Settings, String> {
    let path = dir.join("settings.json");
    if !path.exists() { return Ok(Settings::default()); }
    let s = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("配置文件损坏：{e}"))?;
    validate(&s)?; Ok(s)
}
fn settings_lock(dir: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).open(dir.join("settings.lock")).map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    Ok(file)
}
pub fn save(dir: &Path, old: &Settings, mut next: Settings) -> Result<Settings, String> {
    if next.revision != old.revision { return Err("配置已发生变化，请刷新后重新确认".into()); }
    validate(&next)?;
    let lock = settings_lock(dir)?;
    if load(dir)? != *old { return Err("配置已发生变化，请刷新后重新确认".into()); }
    next.revision += 1;
    atomic_write(&dir.join("settings.previous.json"), &serde_json::to_vec_pretty(old).unwrap())?;
    atomic_write(&dir.join("settings.json"), &serde_json::to_vec_pretty(&next).unwrap())?;
    drop(lock);
    Ok(next)
}
pub fn patch(old: &Settings, changes: &Value) -> Result<Settings, String> {
    let changes = changes.as_object().ok_or("设置修改必须是对象")?;
    let mut value = serde_json::to_value(old).unwrap();
    for (key, v) in changes {
        if !["roots", "theme", "recursive", "filter", "launchers", "assistantReasoning", "translationReasoning", "assistantOutputTokens", "translationOutputTokens", "modelRequestTimeoutSecs", "modelFirstResponseTimeoutSecs", "modelIdleTimeoutSecs", "modelRetryCount", "assistantTaskTimeoutSecs", "assistantHistoryMessages", "assistantHistoryChars", "assistantToolRounds", "assistantSearchLimit", "assistantAutoContinue", "assistantContinueTokens", "modelContextTokens", "modelTemperature", "modelTopP", "modelPricing"].contains(&key.as_str()) { return Err(format!("助手不能修改 {key}")); }
        value[key] = v.clone();
    }
    if changes.get("modelRetryCount").and_then(Value::as_u64).is_some_and(|n|n>2){return Err("重试最多2次".into());}
    let next = serde_json::from_value(value).map_err(|e| format!("配置结构无效：{e}"))?;
    validate(&next)?; Ok(next)
}
pub fn redacted(s: &Settings) -> Value { let mut v=serde_json::to_value(s).unwrap();let map=v.as_object_mut().unwrap();map.remove("modelUrl");map.remove("modelId");v["modelConfigured"]=json!(!s.model_url.is_empty());v }

pub fn import(path: &Path, current: &Settings) -> Result<Settings, String> {
    let mut next: Settings = serde_json::from_slice(&fs::read(path).map_err(|e| format!("无法读取配置文件：{e}"))?).map_err(|e| format!("配置文件格式无效：{e}"))?;
    validate(&next)?;
    next.revision = current.revision;
    Ok(next)
}
pub fn export(path: &Path, current: &Settings) -> Result<(), String> {
    if !path.is_absolute() || !path.extension().and_then(|v|v.to_str()).is_some_and(|v|v.eq_ignore_ascii_case("json")) { return Err("请选择绝对路径并导出为 JSON 文件".into()); }
    validate(current)?;
    atomic_write(path, &serde_json::to_vec_pretty(current).map_err(|e|e.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pricing_patch_is_a_draft_until_saved_and_rejects_stale_revision(){
        let dir=tempfile::tempdir().unwrap();let current=Settings::default();
        atomic_write(&dir.path().join("settings.json"),&serde_json::to_vec(&current).unwrap()).unwrap();
        let mut pricing=current.model_pricing.clone();pricing.rules[0].output_per_million=10.0;
        let next=patch(&current,&json!({"modelPricing":pricing})).unwrap();
        assert_eq!(load(dir.path()).unwrap(),current);
        let saved=save(dir.path(),&current,next.clone()).unwrap();assert_eq!(saved.model_pricing.rules[0].output_per_million,10.0);
        assert!(save(dir.path(),&saved,next).is_err());
        let mut old=serde_json::to_value(&current).unwrap();old.as_object_mut().unwrap().remove("modelPricing");assert_eq!(serde_json::from_value::<Settings>(old).unwrap().model_pricing,current.model_pricing);
    }

    #[test]
    fn configuration_export_import_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("导出的配置.json");
        let source = Settings {
            schema_version: 1, revision: 9, roots: vec![dir.path().to_string_lossy().into_owned()],
            theme: "dark".into(), recursive: false, filter: "pdf".into(),
            launchers: vec![
                Launcher { id: "local".into(), name: "常用文件".into(), path: dir.path().join("报价单.pdf").to_string_lossy().into_owned(), group: "文档".into() },
                Launcher { id: "web".into(), name: "工作门户".into(), path: "https://example.com/office".into(), group: "网页".into() },
            ],
            model_url: "https://example.com/v1".into(), model_id: "办公模型".into(), jev_enabled: true, tavily_enabled: true,
            assistant_reasoning: "medium".into(), translation_reasoning: "low".into(), model_context_tokens: 32000,
            assistant_output_tokens: 8192, translation_output_tokens: 4096, model_request_timeout_secs: 90,
            model_first_response_timeout_secs: 30, model_idle_timeout_secs: 20, model_retry_count: 1,
            assistant_task_timeout_secs: 360, assistant_history_messages: 6, assistant_history_chars: 1800,
            assistant_tool_rounds: 7, assistant_search_limit: 3, assistant_auto_continue: false, assistant_continue_tokens: 1024,
            model_temperature: Some(0.3), model_top_p: Some(0.7), model_pricing: Default::default(),
        };
        export(&path, &source).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(serde_json::from_slice::<Settings>(&bytes).unwrap(), source);
        let current = Settings { revision: 42, ..Settings::default() };
        atomic_write(&dir.path().join("settings.json"), &serde_json::to_vec(&current).unwrap()).unwrap();
        let imported = import(&path, &current).unwrap();
        assert_eq!(load(dir.path()).unwrap(), current);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let expected = Settings { revision: 42, ..source };
        assert_eq!(imported, expected);
        let saved = save(dir.path(), &current, imported).unwrap();
        assert_eq!(saved, Settings { revision: 43, ..expected });
        assert_eq!(load(dir.path()).unwrap(), saved);
    }

    #[test]
    fn configuration_import_rejects_invalid_files_without_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("配置.json");
        let current = Settings::default();
        let original = serde_json::to_vec(&current).unwrap();
        atomic_write(&dir.path().join("settings.json"), &original).unwrap();
        let mut invalid = vec![b"not JSON".to_vec(), br#"{"root_dirs":[]}"#.to_vec()];
        for (key, value) in [
            ("schemaVersion", json!(2)), ("roots", json!(["relative/path"])), ("theme", json!("unknown")),
            ("assistantOutputTokens", json!(10)), ("modelUrl", json!("https://user:password@example.com/v1")),
            ("apiKey", json!("unexpected")),
        ] {
            let mut data = serde_json::to_value(&current).unwrap();
            data[key] = value;
            invalid.push(serde_json::to_vec(&data).unwrap());
        }
        for bytes in invalid {
            fs::write(&path, &bytes).unwrap();
            assert!(import(&path, &current).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::read(dir.path().join("settings.json")).unwrap(), original);
        }
        assert!(import(&dir.path().join("missing.json"), &current).is_err());
        assert!(export(&dir.path().join("配置.txt"), &current).is_err());
        assert!(export(Path::new("relative.json"), &current).is_err());
        assert!(!dir.path().join("配置.txt").exists());
    }
}
