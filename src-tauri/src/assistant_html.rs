use serde::Deserialize;
use serde_json::Value;

pub const MAX_SOURCE_BYTES:usize=1_000_000;
// srcdoc inherits the outer policy. Allow inline game code there too, while
// the sandbox gives the child an opaque origin and no native app privileges.
const OUTER_CSP:&str="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-src about:";
const CHILD_CSP:&str="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HtmlApp {pub filename:String,pub title:String,pub source:String}

pub fn is_html_document(source:&str)->bool{
    let start=source.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    start.starts_with("<!doctype html")||start.starts_with("<html>")||start.starts_with("<html ")||start.starts_with("<html\n")
}
fn attribute(text:&str)->String{text.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&#39;")}
impl HtmlApp{
    pub fn parse(args:Value)->Result<Self,String>{
        let app:Self=serde_json::from_value(args).map_err(|_|"交互网页参数需要 filename、title、source（完整 HTML 源码）")?;
        let path=crate::assistant_fs::relative_path(&app.filename)?;
        if path.components().count()!=1||crate::assistant_fs::extension(&path)?!="html"{return Err("交互网页必须使用工作目录根部的普通 .html 文件名".into());}
        if app.title.trim().is_empty()||app.title.len()>500||app.title.chars().any(char::is_control){return Err("网页标题不能为空、不能包含控制字符，最多 500 字节".into());}
        if app.source.len()>MAX_SOURCE_BYTES{return Err("交互网页源码超过 1 MB，请精简为自包含的单文件网页，不要改用正文段落保存代码".into());}
        if app.source.contains('\0')||!is_html_document(&app.source)||!app.source.to_ascii_lowercase().contains("</html>"){return Err("请提供从 <!doctype html> 或 <html> 开始、包含 </html> 结束标签的完整 HTML，不要包含 Markdown 代码围栏或转义正文".into());}
        Ok(app)
    }
    pub fn render(&self)->Vec<u8>{
        // Put the managed policy in the head before any untrusted source. Extra
        // HTML/head tags are handled by the HTML parser; they cannot relax CSP.
        let child=format!("<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CHILD_CSP}\">{}",self.source);
        format!(r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{OUTER_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>html,body{{height:100%;margin:0;background:#111;color:#eee;font:12px system-ui}}body{{display:flex;flex-direction:column}}header{{padding:8px 12px;line-height:1.5;border-bottom:1px solid #444;flex:none}}iframe{{width:100%;flex:1;min-height:0;border:0;background:#fff}}</style></head><body><header>AI 生成的交互网页 · 请勿输入隐私或密钥。浏览器隔离与资源限制不代表代码已审计。</header><iframe title="{title}" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; hid 'none'; payment 'none'; display-capture 'none'" srcdoc="{source}"></iframe></body></html>"#,title=attribute(&self.title),source=attribute(&child)).into_bytes()
    }
    pub fn preview(&self)->String{format!("{}\n\n完整 HTML 源码（{} 字节，保存时加入浏览器隔离容器）：\n{}",self.title,self.source.len(),self.source)}
}

#[cfg(test)]
mod tests{
    use super::*;
    use serde_json::json;
    #[test]
    fn wrapper_keeps_code_in_the_sandbox(){
        let source="<!doctype html><html><body><canvas></canvas><script>document.title='game';</script></body></html>";
        let app=HtmlApp::parse(json!({"filename":"game.html","title":"\"<game>","source":source})).unwrap();
        let rendered=String::from_utf8(app.render()).unwrap();
        assert!(rendered.contains("sandbox=\"allow-scripts\""));assert!(!rendered.contains("allow-same-origin"));
        assert!(rendered.contains("srcdoc=\"&lt;!doctype html&gt;"));assert!(!rendered.contains("<script>"));
        assert!(rendered.contains("connect-src 'none'"));assert!(rendered.contains("frame-src &#39;none&#39;"));
        assert!(rendered.contains("&lt;script&gt;document.title="));
    }
    #[test]
    fn full_source_has_a_separate_size_limit(){
        let source=format!("<!doctype html><html><body>{}</body></html>","x".repeat(9000));
        assert!(HtmlApp::parse(json!({"filename":"game.html","title":"game","source":source})).is_ok());
        assert!(HtmlApp::parse(json!({"filename":"game.html","title":"game","source":"x".repeat(MAX_SOURCE_BYTES+1)})).is_err());
        assert!(HtmlApp::parse(json!({"filename":"../game.html","title":"game","source":"<!doctype html>"})).is_err());
        assert!(HtmlApp::parse(json!({"filename":"game.html","title":"game","source":"&lt;!doctype html&gt;"})).is_err());
    }
}
