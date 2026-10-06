use std::{collections::{HashMap, HashSet}, path::Path, sync::Mutex, time::Duration};
use chrono::{Local, NaiveDate, NaiveTime, TimeZone};
use serde::Deserialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

const LEAD_MS: i64 = 10 * 60 * 1000;

#[cfg(windows)]
fn register_notification_app(app_id: &str, display_name: &str) -> Result<(), String> {
    // NSIS 安装不等于通知身份已注册；开发版和安装版均注册自己的身份。
    let user = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (key, _) = user.create_subkey(format!(r"Software\Classes\AppUserModelId\{app_id}"))
        .map_err(|e| format!("无法注册 Windows 通知身份：{e}"))?;
    // 每轮检查可修复缺失的注册项，但不反复写入，也不改动用户的通知开关。
    if key.get_value::<String, _>("DisplayName").ok().as_deref() != Some(display_name) {
        key.set_value("DisplayName", &display_name)
            .map_err(|e| format!("无法保存 Windows 通知名称：{e}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn notification_ready_for_id(app_id: &str, display_name: &str) -> Result<(), String> {
    use windows::{core::HSTRING, UI::Notifications::{NotificationSetting, ToastNotificationManager}};
    register_notification_app(app_id, display_name)?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .map_err(|e| format!("无法连接 Windows 通知：{e}"))?;
    match notifier.Setting() {
        Ok(NotificationSetting::Enabled) => Ok(()),
        // 首次发送前尚无通知设置记录；让第一条通知建立记录，发送失败仍由 show 报错。
        Err(e) if e.code().0 as u32 == 0x80070490 => Ok(()),
        Err(e) => Err(format!("无法读取 Windows 通知状态：{e}")),
        Ok(_) => Err("系统已关闭通知，请在 Windows 设置 → 系统 → 通知中开启。".into()),
    }
}

#[cfg(windows)]
fn notification_ready(app: &tauri::AppHandle) -> Result<(), String> {
    notification_ready_for_id(&app.config().identifier, app.config().product_name.as_deref().unwrap_or("工作台"))
}

#[cfg(windows)]
fn show_reminder(app: &tauri::AppHandle, todo: &Todo, body: &str) -> Result<(), String> {
    let handle = app.clone();
    let id = todo.id.clone();
    // 直接等待原生发送结果，失败不登记为“已提醒”。
    tauri_winrt_notification::Toast::new(&app.config().identifier)
        .title("待办提醒").text1(&todo.title).text2(body)
        .sound(Some(tauri_winrt_notification::Sound::Default))
        .on_activated(move |_| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = handle.emit("todo-reminder-open", &id);
            Ok(())
        }).show().map_err(|e| format!("Windows 通知发送失败：{e}"))
}

#[cfg(not(windows))]
fn notification_ready(_: &tauri::AppHandle) -> Result<(), String> { Err("待办系统提醒仅支持 Windows。".into()) }
#[cfg(not(windows))]
fn show_reminder(_: &tauri::AppHandle, _: &Todo, _: &str) -> Result<(), String> { Err("待办系统提醒仅支持 Windows。".into()) }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Todo {
    id: String,
    title: String,
    #[serde(rename = "type")]
    kind: String,
    completed: bool,
    due_date: Option<String>,
    due_time: Option<String>,
    deleted_at: Option<i64>,
}

impl Todo {
    fn active(&self) -> bool {
        self.kind == "todo" && !self.completed && self.deleted_at.is_none()
    }

    fn deadline(&self) -> Option<i64> {
        let date = NaiveDate::parse_from_str(self.due_date.as_deref()?, "%Y-%m-%d").ok()?;
        let time = NaiveTime::parse_from_str(self.due_time.as_deref()?, "%H:%M").ok()?;
        Local.from_local_datetime(&date.and_time(time)).single().map(|v| v.timestamp_millis())
    }
}

#[derive(Default)]
struct ReminderState {
    sent: Option<HashMap<String, i64>>,
    error: Option<String>,
}

#[derive(Default)]
pub struct TodoReminders(Mutex<ReminderState>);

fn read_todos(dir: &Path) -> Result<Value, String> {
    let path = dir.join("todos.json");
    if !path.exists() { return Ok(serde_json::json!([])); }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn validate_todos(todos: &Value) -> Result<(), String> {
    let parsed: Vec<Todo> = serde_json::from_value(todos.clone()).map_err(|_| "待办数据格式不正确")?;
    let mut ids = HashSet::new();
    for (todo, raw) in parsed.iter().zip(todos.as_array().ok_or("待办数据格式不正确")?) {
        if todo.id.is_empty() || !ids.insert(todo.id.as_str()) || todo.title.trim().is_empty() ||
            !matches!(todo.kind.as_str(), "todo" | "idea") ||
            !raw["quadrant"].as_u64().is_some_and(|q| q <= 4) ||
            raw["createdAt"].as_i64().is_none() {
            return Err("待办标识、内容或分类不正确".into());
        }
        if let Some(version) = raw.get("schemaVersion") {
            if !matches!(version.as_u64(), Some(1 | 2)) { return Err("待办数据版本不支持".into()); }
        }
        if let Some(steps) = raw.get("subtasks") {
            let mut step_ids = HashSet::new();
            for step in steps.as_array().ok_or("步骤数据格式不正确")? {
                if let Some(title) = step.as_str() {
                    if title.trim().is_empty() { return Err("步骤内容不能为空".into()); }
                    continue;
                }
                let id = step["id"].as_str().filter(|id| !id.is_empty()).ok_or("步骤标识不正确")?;
                if !step_ids.insert(id) || step["title"].as_str().is_none_or(|title| title.trim().is_empty()) ||
                    step["completed"].as_bool().is_none() { return Err("步骤数据格式不正确".into()); }
            }
        }
    }
    Ok(())
}

impl TodoReminders {
    pub fn read(&self, dir: &Path) -> Result<Value, String> {
        let _guard = self.0.lock().map_err(|_| "待办存储暂不可用")?;
        read_todos(dir)
    }

    pub fn save(&self, dir: &Path, todos: Value) -> Result<(), String> {
        let _guard = self.0.lock().map_err(|_| "待办存储暂不可用")?;
        validate_todos(&todos)?;
        let path = dir.join("todos.json");
        if path.exists() {
            let previous = std::fs::read(&path).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_slice(&previous).map_err(|_| "原待办数据损坏，未覆盖")?;
            validate_todos(&value)?;
            crate::settings::atomic_write(&dir.join("todos.previous.json"), &previous)?;
            // 首次升级前的原始数据单独保留，后续保存不覆盖，便于降级恢复。
            let legacy = dir.join("todos.legacy.json");
            if !legacy.exists() && value.as_array().is_some_and(|items| items.iter().any(|t| t["schemaVersion"] != 2)) {
                crate::settings::atomic_write(&legacy, &previous)?;
            }
        }
        // 原始对象落盘，保留子任务和历史版本的其他字段。
        let bytes = serde_json::to_vec_pretty(&todos).map_err(|e| e.to_string())?;
        crate::settings::atomic_write(&dir.join("todos.json"), &bytes)
    }

    pub fn status(&self) -> Option<String> {
        self.0.lock().ok().and_then(|s| s.error.clone())
    }

    fn check(&self, dir: &Path, app: &tauri::AppHandle, state: &mut ReminderState) -> Result<(), String> {
        let ledger = dir.join("todo-reminders.json");
        if state.sent.is_none() {
            state.sent = Some(if ledger.exists() {
                serde_json::from_slice(&std::fs::read(&ledger).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?
            } else { HashMap::new() });
        }
        let todos: Vec<Todo> = serde_json::from_value(read_todos(dir)?).map_err(|_| "待办数据无法读取")?;
        notification_ready(app)?;
        let sent = state.sent.as_mut().unwrap();
        let before = sent.clone();
        // 改期重新计时；删除、清除日期或转为灵感后清理记录。
        sent.retain(|id, deadline| todos.iter().any(|t| &t.id == id && t.deleted_at.is_none() && t.kind == "todo" && t.deadline() == Some(*deadline)));
        let mut notification_error = None;
        for todo in todos.iter().filter(|t| t.active()) {
            let Some(deadline) = todo.deadline() else { continue; };
            let now = Local::now().timestamp_millis();
            // 已逾期不补发；不足十分钟时尽快通知。相同日期时间只提醒一次。
            if deadline <= now || deadline - now > LEAD_MS || sent.get(&todo.id) == Some(&deadline) { continue; }
            let minutes = (deadline - now + 59_999) / 60_000;
            let body = format!("{} {} 到期，约 {} 分钟后。",
                todo.due_date.as_deref().unwrap_or_default(), todo.due_time.as_deref().unwrap_or_default(), minutes);
            match show_reminder(app, todo, &body) {
                Ok(()) => { sent.insert(todo.id.clone(), deadline); }
                Err(e) => { notification_error = Some(e); }
            }
        }
        // 成功后持久化去重；写入失败保留内存记录，下一轮继续尝试落盘。
        if *sent != before || !ledger.exists() || state.error.is_some() {
            let bytes = serde_json::to_vec_pretty(sent).map_err(|e| e.to_string())?;
            crate::settings::atomic_write(&ledger, &bytes)?;
        }
        notification_error.map_or(Ok(()), Err)
    }

    pub fn start(app: tauri::AppHandle) {
        std::thread::spawn(move || loop {
            let app_state = app.state::<std::sync::Arc<crate::AppState>>();
            let reminders = &app_state.todo_reminders;
            if let Ok(mut state) = reminders.0.lock() {
                let error = reminders.check(&app_state.dir, &app, &mut state).err();
                if state.error != error {
                    state.error = error;
                    let _ = app.emit("todo-reminder-status", &state.error);
                }
            }
            std::thread::sleep(Duration::from_secs(15));
        });
    }
}
