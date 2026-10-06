use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_IMAGES:usize=4;
const MAX_BYTES:usize=5*1024*1024;
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Image { id:String,name:String,mime_type:String,size:usize,data_url:String }

fn validate_images(value:&Value,count:&mut usize)->Result<(),String>{
    if value.is_null(){return Ok(());}
    let images=value.as_array().ok_or("图片附件必须是列表")?;
    *count+=images.len();if *count>MAX_IMAGES{return Err("每次请求最多携带 4 张当前及历史图片".into());}
    for value in images{
        let image:Image=serde_json::from_value(value.clone()).map_err(|_|"图片附件格式无效")?;
        if image.id.is_empty()||image.id.len()>200||image.name.len()>1024||image.size==0||image.size>MAX_BYTES{return Err("图片标识无效，或单张图片超过 5 MB".into());}
        if !["image/png","image/jpeg","image/webp","image/gif"].contains(&image.mime_type.as_str()){return Err("仅支持 PNG、JPEG、WebP 和 GIF 图片".into());}
        let prefix=format!("data:{};base64,",image.mime_type);
        let encoded=image.data_url.strip_prefix(&prefix).ok_or("图片必须是用户提供的内嵌数据，不能使用网址或本地路径")?;
        if encoded.len()>MAX_BYTES.div_ceil(3)*4{return Err("图片编码超过 5 MB 限制".into());}
        let bytes=STANDARD.decode(encoded).map_err(|_|"图片编码无效")?;
        if bytes.len()!=image.size{return Err("图片大小与实际内容不一致".into());}
        let valid=match image.mime_type.as_str(){
            "image/png"=>bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg"=>bytes.starts_with(&[0xff,0xd8,0xff]),
            "image/webp"=>bytes.starts_with(b"RIFF")&&bytes.get(8..12)==Some(b"WEBP"),
            "image/gif"=>bytes.starts_with(b"GIF87a")||bytes.starts_with(b"GIF89a"),
            _=>false,
        };
        if !valid{return Err("图片内容与声明格式不符，请重新添加有效图片".into());}
    }Ok(())
}
// 只接收用户显式提交的图片数据；不读取路径，也不下载远程图片。
pub fn validate_context(context:&Value)->Result<(),String>{
    let mut count=0;validate_images(&context["images"],&mut count)?;
    if let Some(history)=context["history"].as_array(){
        if history.len()>12{return Err("助手历史最多 12 条消息".into());}
        for item in history{
            if !matches!(item["role"].as_str(),Some("user"|"assistant")){return Err("助手历史消息角色无效".into());}
            if item["role"]!="user"&&has_items(&item["images"]){return Err("图片只能附在用户消息中".into());}
            validate_images(&item["images"],&mut count)?;
        }
    }Ok(())
}
fn has_items(value:&Value)->bool{value.as_array().is_some_and(|items|!items.is_empty())}
pub fn has_images(context:&Value)->bool{
    has_items(&context["images"])||context["history"].as_array().is_some_and(|items|items.iter().any(|item|has_items(&item["images"])))
}
pub fn content(text:&str,images:&Value)->Value{
    if !has_items(images){return json!(text);}
    let mut parts=vec![json!({"type":"text","text":text})];
    for image in images.as_array().unwrap(){parts.push(json!({"type":"image_url","image_url":{"url":image["dataUrl"]}}));}
    json!(parts)
}
pub fn messages(prompt:&str,context:&Value)->Vec<Value>{
    let mut messages=vec![];
    if let Some(history)=context["history"].as_array(){for item in history{
        let text=item["content"].as_str().unwrap_or("");
        if !text.is_empty()||has_items(&item["images"]){messages.push(json!({"role":item["role"],"content":content(text,&item["images"])}));}
    }}
    messages.push(json!({"role":"user","content":content(prompt,&context["images"])}));messages
}
