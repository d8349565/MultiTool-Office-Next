use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
use tauri::{AppHandle,Manager};
use tokio::sync::oneshot;

type Reply=Arc<Mutex<Option<oneshot::Sender<Result<Vec<u8>,String>>>>>;
fn finish(reply:&Reply,result:Result<Vec<u8>,String>){
    if let Some(sender)=reply.lock().unwrap().take(){let _=sender.send(result);}
}
struct PrintWindow{app:AppHandle,label:String}
impl Drop for PrintWindow{
    fn drop(&mut self){
        let app=self.app.clone();let label=self.label.clone();
        let _=self.app.run_on_main_thread(move||{if let Some(window)=app.get_webview_window(&label){let _=window.destroy();}});
    }
}

#[cfg(windows)]
fn print(window:tauri::WebviewWindow,reply:Reply){
    use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2_16,ICoreWebView2Environment6},PrintToPdfStreamCompletedHandler};
    use windows_core::Interface;
    let fallback=reply.clone();
    let started=window.with_webview(move|view|{
        let result=(||->Result<(),String>{
            let core=unsafe{view.controller().CoreWebView2()}.map_err(|e|format!("PDF 排版组件不可用：{e}"))?;
            let printer=core.cast::<ICoreWebView2_16>().map_err(|_|"当前 WebView2 版本不支持 PDF 内存导出，请更新 WebView2 后重试")?;
            let environment=view.environment().cast::<ICoreWebView2Environment6>().map_err(|_|"当前 WebView2 版本不支持 PDF 打印设置")?;
            let settings=unsafe{environment.CreatePrintSettings()}.map_err(|e|format!("无法创建 PDF 打印设置：{e}"))?;
            unsafe{
                settings.SetPageWidth(210.0/25.4)
                    .and_then(|_|settings.SetPageHeight(297.0/25.4))
                    .and_then(|_|settings.SetMarginTop(0.4)).and_then(|_|settings.SetMarginBottom(0.4))
                    .and_then(|_|settings.SetMarginLeft(0.4)).and_then(|_|settings.SetMarginRight(0.4))
                    .and_then(|_|settings.SetShouldPrintHeaderAndFooter(false)).and_then(|_|settings.SetShouldPrintBackgrounds(true))
            }.map_err(|e|format!("无法设置 PDF 纸张及页边距：{e}"))?;
            let completed=reply.clone();
            let callback=PrintToPdfStreamCompletedHandler::create(Box::new(move|status,stream|{
                let result=(||->Result<Vec<u8>,String>{
                    status.map_err(|e|format!("PDF 排版失败：{e}"))?;
                    let stream=stream.ok_or("PDF 排版组件未返回文件")?;
                    let mut bytes=Vec::new();let mut buffer=[0u8;65_536];
                    loop{
                        let mut read=0;
                        unsafe{stream.Read(buffer.as_mut_ptr().cast(),buffer.len() as u32,Some(&mut read))}.ok().map_err(|_|"无法读取 PDF 生成结果")?;
                        if read==0{break;}
                        if bytes.len()+read as usize>8_000_000{return Err("PDF 超过 8 MB 上限，请减少内容或拆分文档".into());}
                        bytes.extend_from_slice(&buffer[..read as usize]);
                    }
                    if !bytes.starts_with(b"%PDF-"){return Err("生成结果不是有效 PDF，未保存文件".into());}
                    Ok(bytes)
                })();
                finish(&completed,result);Ok(())
            }));
            unsafe{printer.PrintToPdfStream(&settings,&callback)}.map_err(|e|format!("无法开始 PDF 排版：{e}"))
        })();
        if let Err(error)=result{finish(&reply,Err(error));}
    });
    if let Err(error)=started{finish(&fallback,Err(format!("无法调用 PDF 排版组件：{error}")));}
}

pub async fn render(app:&AppHandle,html:String,cancel:&AtomicBool)->Result<Vec<u8>,String>{
    #[cfg(not(windows))] {let _=(app,html,cancel);return Err("PDF 创建目前仅支持 Windows 桌面版".into());}
    #[cfg(windows)] {
        use base64::Engine;
        use tauri::{WebviewWindowBuilder,WebviewUrl};
        use webview2_com::{NavigationStartingEventHandler,NavigationCompletedEventHandler,take_pwstr};
        use windows_core::{HSTRING,PWSTR};
        use std::sync::atomic::AtomicU64;
        if cancel.load(Ordering::Relaxed){return Err("任务已取消，未生成 PDF".into());}
        let label=format!("pdf-export-{}",uuid::Uuid::new_v4());
        let _window=PrintWindow{app:app.clone(),label:label.clone()};
        let url=format!("data:text/html;base64,{}",base64::engine::general_purpose::STANDARD.encode(html));
        let (sender,result)=oneshot::channel();let reply:Reply=Arc::new(Mutex::new(Some(sender)));
        let failure=reply.clone();let handle=app.clone();
        app.run_on_main_thread(move||{
            // 只装载受控静态模板；禁用脚本和外部导航，不加载主应用、不落地临时文件。
            let built=WebviewWindowBuilder::new(&handle,&label,WebviewUrl::External("about:blank".parse().unwrap()))
                .visible(false).focused(false).skip_taskbar(true).disable_javascript()
                .on_navigation(|url|url.scheme()=="data"||url.as_str()=="about:blank").build();
            match built{
                Err(error)=>finish(&reply,Err(format!("无法初始化 PDF 排版组件：{error}"))),
                Ok(window)=>{
                    let loaded=reply.clone();let fallback=reply.clone();let page=window.clone();
                    let attached=window.with_webview(move|view|{
                        let setup=(||->Result<(),String>{
                            let core=unsafe{view.controller().CoreWebView2()}.map_err(|e|e.to_string())?;
                            let navigation=Arc::new(AtomicU64::new(0));let active=navigation.clone();let expected=url.clone();
                            let starting=NavigationStartingEventHandler::create(Box::new(move|_,args|{
                                if let Some(args)=args{
                                    let mut uri=PWSTR::null();unsafe{args.Uri(&mut uri)}?;
                                    if take_pwstr(uri)==expected{let mut id=0;unsafe{args.NavigationId(&mut id)}?;active.store(id,Ordering::Relaxed);}
                                }
                                Ok(())
                            }));
                            let mut token=0;
                            unsafe{core.add_NavigationStarting(&starting,&mut token)}.map_err(|e|e.to_string())?;
                            let started=AtomicBool::new(false);
                            let callback=NavigationCompletedEventHandler::create(Box::new(move|_,args|{
                                let Some(args)=args else{finish(&loaded,Err("PDF 页面未返回加载状态".into()));return Ok(());};
                                let mut id=0;unsafe{args.NavigationId(&mut id)}?;
                                if id!=navigation.load(Ordering::Relaxed)||id==0||started.swap(true,Ordering::Relaxed){return Ok(());}
                                let mut success=Default::default();
                                match unsafe{args.IsSuccess(&mut success)}{
                                    Ok(()) if success.as_bool()=>print(page.clone(),loaded.clone()),
                                    _=>finish(&loaded,Err("PDF 排版页面加载失败，未保存文件".into())),
                                }
                                Ok(())
                            }));
                            unsafe{core.add_NavigationCompleted(&callback,&mut token)}.map_err(|e|e.to_string())?;
                            // 直接装载内存模板，避免框架改写 data URL 后将 CSS 中的 # 当成片段而截断正文。
                            unsafe{core.Navigate(&HSTRING::from(url))}.map_err(|e|e.to_string())?;
                            Ok(())
                        })();
                        if let Err(error)=setup{finish(&reply,Err(format!("无法监听 PDF 页面加载：{error}")));}
                    });
                    if let Err(error)=attached{finish(&fallback,Err(error.to_string()));}
                }
            }
        }).map_err(|error|{finish(&failure,Err(error.to_string()));"无法启动 PDF 排版".to_owned()})?;
        tokio::select!{
            value=result=>value.map_err(|_|"PDF 排版已中断，请重试".to_owned())?,
            _=tokio::time::sleep(std::time::Duration::from_secs(30))=>Err("PDF 排版超过 30 秒，未保存文件；请减少内容后重试".into()),
            _=async{while !cancel.load(Ordering::Relaxed){tokio::time::sleep(std::time::Duration::from_millis(80)).await;}}=>Err("任务已取消，未生成 PDF".into()),
        }
    }
}
