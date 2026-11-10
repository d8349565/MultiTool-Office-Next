use std::collections::{BTreeMap, HashSet};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub type Bindings = BTreeMap<String, Option<String>>;

pub fn defaults() -> Bindings {
    serde_json::from_str(include_str!("../../src/defaultShortcuts.json")).expect("valid default shortcuts")
}

pub fn global(bindings: &Bindings) -> Option<&str> {
    bindings.get("globalQuick").and_then(Option::as_deref)
}

pub fn validate(bindings: &Bindings) -> Result<(), String> {
    if !bindings.keys().eq(defaults().keys()) {
        return Err("快捷键配置缺少操作或包含未知操作".into());
    }
    let mut used = HashSet::new();
    for (action, binding) in bindings {
        let Some(binding) = binding.as_deref() else { continue };
        let Some((modifiers, key)) = binding.rsplit_once('+') else { return Err("快捷键缺少修饰键".into()) };
        let character = matches!(key.as_bytes(), [b'A'..=b'Z' | b'0'..=b'9']);
        if binding != "Ctrl+Shift+Space"
            && (!character || !matches!(modifiers, "Ctrl" | "Ctrl+Shift" | "Ctrl+Alt" | "Ctrl+Alt+Shift" | "Alt" | "Alt+Shift"))
        {
            return Err("快捷键需要 Ctrl 或 Alt 搭配字母或数字".into());
        }
        if matches!(modifiers, "Ctrl" | "Ctrl+Shift") && "ACNPRSTVWXYZ".contains(key) {
            return Err(format!("快捷键 {binding} 与常用编辑或窗口操作冲突"));
        }
        if action == "globalQuick" && !matches!(modifiers, "Ctrl+Shift" | "Ctrl+Alt" | "Ctrl+Alt+Shift") {
            return Err("全局快捷键请同时使用 Ctrl 和 Shift 或 Alt".into());
        }
        if !used.insert(binding) { return Err(format!("快捷键 {binding} 已分配给另一项操作")); }
    }
    Ok(())
}

pub fn register(app: &tauri::AppHandle, binding: &str) -> Result<(), String> {
    app.global_shortcut().register(binding)
        .map_err(|_| format!("无法启用全局快捷键 {binding}，可能被系统或其他程序占用。请换一个组合键。"))
}

pub fn registered(app: &tauri::AppHandle, binding: Option<&str>) -> bool {
    binding.is_some_and(|key| app.global_shortcut().is_registered(key))
}

pub fn matches(binding: Option<&str>, pressed: &Shortcut) -> bool {
    binding.and_then(|key| key.parse::<Shortcut>().ok()).is_some_and(|key| &key == pressed)
}

pub fn save<T>(app: &tauri::AppHandle, old: Option<&str>, new: Option<&str>, write: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if old == new { return write(); }
    // 先注册新键，遇到占用或保存失败时原来的组合键仍然可用。
    if let Some(key) = new { register(app, key)?; }
    let result = write();
    let to_release = if result.is_ok() { old } else { new };
    if let Some(key) = to_release {
        if registered(app, Some(key)) {
            if let Err(error) = app.global_shortcut().unregister(key) { eprintln!("Shortcut release failed: {error}"); }
        }
    }
    result
}
