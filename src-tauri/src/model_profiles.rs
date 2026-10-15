use crate::{ai, settings::{self, ModelProfile, Settings}, AppState};
use serde_json::{json, Value};
use std::sync::{Arc, atomic::AtomicBool};
use tauri::Emitter;

pub fn profiles(s:&Settings)->Vec<ModelProfile>{
    let mut profiles=s.model_profiles.clone();
    if s.active_model_profile_id.is_none() && !s.model_url.is_empty() && !s.model_id.is_empty() && !profiles.iter().any(|p|p.id=="legacy") {
        profiles.insert(0,ModelProfile{id:"legacy".into(),name:"原有模型配置".into(),model_url:s.model_url.clone(),model_id:s.model_id.clone(),tested_at:None,credential_revision:0});
    }
    profiles
}
pub fn credential(id:Option<&str>)->String{
    match id{None|Some("legacy")=>"model".into(),Some(id)=>format!("model-{id}")}
}
fn for_profile(s:&Settings,p:&ModelProfile)->Settings{
    Settings{model_url:p.model_url.clone(),model_id:p.model_id.clone(),active_model_profile_id:Some(p.id.clone()),..s.clone()}
}
fn normalize(mut p:ModelProfile)->Result<ModelProfile,String>{
    p.name=p.name.trim().into();p.model_id=p.model_id.trim().into();p.model_url=crate::model_adapter::endpoint(&p.model_url)?;
    settings::validate_model_profile(&p)?;Ok(p)
}
fn contains_connection(s:&Settings,p:&ModelProfile)->bool{
    profiles(s).iter().any(|existing|existing.model_id==p.model_id && crate::model_adapter::endpoint(&existing.model_url).ok().as_deref()==Some(p.model_url.as_str()))
}
fn announce(app:&tauri::AppHandle,s:&Settings){let _=app.emit("settings-updated",s);}
fn persist(state:&AppState,current:&mut Settings,next:Settings,profile_id:&str,secret:Option<&str>)->Result<Settings,String>{
    let entry=ai::key(&credential(Some(profile_id)))?;
    let previous=if secret.is_some(){match entry.get_password(){Ok(value)=>Some(value),Err(keyring::Error::NoEntry)=>None,Err(e)=>return Err(format!("无法读取原密钥状态：{e}"))}}else{None};
    if let Some(secret)=secret{entry.set_password(secret).map_err(|e|format!("无法保存密钥：{e}"))?;}
    match settings::save(&state.dir,current,next){
        Ok(saved)=>{*current=saved.clone();Ok(saved)},
        Err(error)=>{
            if secret.is_some(){let restored=if let Some(previous)=previous{entry.set_password(&previous)}else{entry.delete_credential()};if restored.is_err(){return Err(format!("{error}；密钥恢复失败，请在设置中重新测试并保存密钥"));}}
            Err(error)
        }
    }
}
// 密钥留在原生层；只允许同一服务来源复用，不将当前密钥发给其他厂商。
pub async fn add_for_assistant(state:&AppState,app:&tauri::AppHandle,name:&str,url:&str,model:&str,cancel:&AtomicBool)->Result<Value,String>{
    let mut profile=normalize(ModelProfile{id:uuid::Uuid::new_v4().to_string(),name:name.into(),model_url:url.into(),model_id:model.into(),tested_at:None,credential_revision:0})?;
    let snapshot=state.settings.lock().unwrap().clone();
    if contains_connection(&snapshot,&profile){return Err("这份模型配置已存在，请在设置中选择并测试".into());}
    let origin=reqwest::Url::parse(&profile.model_url).unwrap().origin();
    let secret=profiles(&snapshot).iter().filter(|p|reqwest::Url::parse(&p.model_url).ok().is_some_and(|u|u.origin()==origin))
        .find_map(|p|ai::key(&credential(Some(&p.id))).ok().and_then(|entry|entry.get_password().ok()).filter(|s|!s.is_empty()));
    let result=if let Some(secret)=secret.as_deref(){let result=ai::test_connection(&for_profile(&snapshot,&profile),Some(secret),cancel).await?;profile.tested_at=Some(now());profile.credential_revision=1;Some(result)}else{None};
    if cancel.load(std::sync::atomic::Ordering::Relaxed){return Err("任务已取消".into());}
    let mut current=state.settings.lock().unwrap();let mut next=current.clone();next.model_profiles=profiles(&current);
    if contains_connection(&current,&profile){return Err("这份模型配置已存在，请在设置中选择并测试".into());}
    next.model_profiles.push(profile.clone());settings::validate(&next)?;
    let saved=if secret.is_some(){persist(state,&mut current,next,&profile.id,secret.as_deref())?}else{let saved=settings::save(&state.dir,&current,next)?;*current=saved.clone();saved};
    drop(current);announce(app,&saved);
    Ok(json!({"status":if result.is_some(){"added_tested_ready"}else{"added_needs_key_and_test"},"profileId":profile.id,"name":profile.name,"test":result,"message":if profile.tested_at.is_some(){"独立配置已新增，使用同一服务已保存的密钥验证通过。请在设置中手动选择使用，当前模型未切换。"}else{"已新增独立配置。请在设置的模型连接中填写该服务密钥并测试，成功后手动选择使用。当前模型未切换。"}}))
}

#[tauri::command]
pub async fn model_profile_add(state:tauri::State<'_,Arc<AppState>>,app:tauri::AppHandle,mut profile:ModelProfile,secret:String)->Result<Value,String>{
    profile.id=uuid::Uuid::new_v4().to_string();profile.tested_at=None;profile.credential_revision=0;let mut profile=normalize(profile)?;
    if secret.trim().is_empty(){return Err("请填写这份配置的 API 密钥".into());}
    let snapshot=state.settings.lock().unwrap().clone();
    if contains_connection(&snapshot,&profile){return Err("这份模型配置已存在，请选择它后测试并保存密钥".into());}
    let result=ai::test_connection(&for_profile(&snapshot,&profile),Some(secret.trim()),&AtomicBool::new(false)).await?;
    profile.tested_at=Some(now());profile.credential_revision=1;
    let mut current=state.settings.lock().unwrap();let mut next=current.clone();next.model_profiles=profiles(&current);
    if contains_connection(&current,&profile){return Err("这份模型配置已存在，请选择它后测试并保存密钥".into());}
    next.model_profiles.push(profile.clone());settings::validate(&next)?;
    let saved=persist(&state,&mut current,next,&profile.id,Some(secret.trim()))?;drop(current);announce(&app,&saved);
    Ok(json!({"settings":saved,"result":result,"profileId":profile.id}))
}

#[tauri::command]
pub async fn model_test(state:tauri::State<'_,Arc<AppState>>,app:tauri::AppHandle,profile_id:String,secret:Option<String>)->Result<Value,String>{
    let snapshot=state.settings.lock().unwrap().clone();
    let profile=profiles(&snapshot).into_iter().find(|p|p.id==profile_id).ok_or("模型配置不存在")?;
    settings::validate_model_profile(&profile)?;
    let secret=secret.as_deref().map(str::trim).filter(|s|!s.is_empty());
    let result=ai::test_connection(&for_profile(&snapshot,&profile),secret,&AtomicBool::new(false)).await?;
    let mut current=state.settings.lock().unwrap();let mut next=current.clone();next.model_profiles=profiles(&current);
    let stored=next.model_profiles.iter_mut().find(|p|p.id==profile_id).ok_or("配置已变化，请重新选择并测试")?;
    if stored.model_url!=profile.model_url||stored.model_id!=profile.model_id{return Err("配置已变化，请重新测试".into());}
    stored.tested_at=Some(now());
    if secret.is_some(){stored.credential_revision=stored.credential_revision.checked_add(1).ok_or("密钥版本超出范围，请新增配置")?;}
    let saved=persist(&state,&mut current,next,&profile_id,secret)?;drop(current);announce(&app,&saved);
    Ok(json!({"settings":saved,"result":result,"profileId":profile_id}))
}

#[tauri::command]
pub fn model_profile_activate(state:tauri::State<Arc<AppState>>,app:tauri::AppHandle,profile_id:String)->Result<Settings,String>{
    let mut current=state.settings.lock().unwrap();let mut next=current.clone();next.model_profiles=profiles(&current);
    let profile=next.model_profiles.iter().find(|p|p.id==profile_id).ok_or("模型配置不存在")?;
    if profile.tested_at.is_none(){return Err("请先测试此配置，成功后才能使用".into());}
    ai::key(&credential(Some(&profile_id)))?.get_password().map_err(|_|"这份配置尚未保存密钥，请先测试并保存")?;
    next.model_url=profile.model_url.clone();next.model_id=profile.model_id.clone();next.active_model_profile_id=Some(profile_id);
    let saved=settings::save(&state.dir,&current,next)?;*current=saved.clone();drop(current);announce(&app,&saved);Ok(saved)
}
fn now()->u64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn legacy_connection_and_credentials_survive_adding_profiles(){
        let old=Settings{model_url:"https://api.deepseek.com/v1".into(),model_id:"original".into(),..Settings::default()};
        let mut next=old.clone();next.model_profiles=profiles(&old);
        next.model_profiles.push(ModelProfile{id:"new".into(),name:"备用模型".into(),model_url:"https://api.minimax.cn/v1/chat/completions".into(),model_id:"MiniMax-M2.7".into(),tested_at:None,credential_revision:0});
        settings::validate(&next).unwrap();assert_eq!(next.model_url,old.model_url);assert_eq!(next.model_id,old.model_id);assert_eq!(next.active_model_profile_id,old.active_model_profile_id);
        assert_eq!(credential(Some("legacy")),"model");assert_eq!(credential(Some("new")),"model-new");
        assert!(settings::patch(&old,&json!({"modelProfiles":next.model_profiles})).is_err());
        assert!(settings::patch(&old,&json!({"activeModelProfileId":"new"})).is_err());
    }
}
