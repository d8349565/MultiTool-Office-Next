use std::{path::Path, sync::{Arc,Mutex,mpsc},time::Duration};
use serde::{Serialize,Deserialize};

#[derive(Clone,Serialize,Deserialize)]
struct Geometry {width:f64,height:f64,x:i32,y:i32,maximized:bool}

pub fn install(window:tauri::WebviewWindow,dir:&Path){
    let path=dir.join("window-state.json");
    let saved=std::fs::read(&path).ok().and_then(|v|serde_json::from_slice::<Geometry>(&v).ok());
    if let Some(s)=&saved {
        if valid(s){
            let _=window.set_size(tauri::LogicalSize::new(s.width,s.height));
            let visible=window.available_monitors().unwrap_or_default().iter().any(|m|{
                let p=m.position();let size=m.size();let x=s.x as i64;let y=s.y as i64;
                x>=p.x as i64 && x+100<p.x as i64+size.width as i64 && y>=p.y as i64 && y+60<p.y as i64+size.height as i64
            });
            if visible{let _=window.set_position(tauri::PhysicalPosition::new(s.x,s.y));}else{let _=window.center();}
            if s.maximized{let _=window.maximize();}
        }
    }
    let initial=saved.filter(valid).unwrap_or(Geometry{width:1240.,height:840.,x:0,y:0,maximized:false});
    let state=Arc::new(Mutex::new(initial));let worker_state=state.clone();let worker_path=path.clone();
    let (tx,rx)=mpsc::channel::<()>();
    std::thread::spawn(move||while rx.recv().is_ok(){
        while rx.recv_timeout(Duration::from_millis(250)).is_ok(){}
        if let Ok(g)=worker_state.lock(){if let Ok(bytes)=serde_json::to_vec(&*g){let _=crate::settings::atomic_write(&worker_path,&bytes);}}
    });
    let w=window.clone();
    window.on_window_event(move|event|{
        if !matches!(event,tauri::WindowEvent::Moved(_)|tauri::WindowEvent::Resized(_)|tauri::WindowEvent::CloseRequested{..}|tauri::WindowEvent::Destroyed){return;}
        if w.is_minimized().unwrap_or(false){return;}
        let mut g=state.lock().unwrap();g.maximized=w.is_maximized().unwrap_or(false);
        if !g.maximized {
            if let (Ok(size),Ok(scale),Ok(position))=(w.inner_size(),w.scale_factor(),w.outer_position()){
                let logical=size.to_logical::<f64>(scale);
                if logical.width>=900. && logical.height>=620.{g.width=logical.width;g.height=logical.height;g.x=position.x;g.y=position.y;}
            }
        }
        if matches!(event,tauri::WindowEvent::CloseRequested{..}|tauri::WindowEvent::Destroyed){
            if let Ok(bytes)=serde_json::to_vec(&*g){let _=crate::settings::atomic_write(&path,&bytes);}
        }else{let _=tx.send(());}
    });
}
fn valid(g:&Geometry)->bool{g.width.is_finite()&&g.height.is_finite()&&(900.0..=20000.0).contains(&g.width)&&(620.0..=20000.0).contains(&g.height)}
