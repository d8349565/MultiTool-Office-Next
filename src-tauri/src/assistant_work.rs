use crate::index::{Entry, Index, temporary_name};
use chrono::{DateTime, Local, NaiveDate};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, HashSet}, path::Path, sync::OnceLock};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", default, deny_unknown_fields)]
pub struct Request {
    pub query:String, pub kind:String, pub root:Option<String>, pub extension:String,
    pub after:Option<String>, pub before:Option<String>, pub sort:String, pub group_by:String,
    pub latest_only:bool, pub name_only:bool, pub object_level:Option<usize>, pub theme_level:Option<usize>, pub offset:usize,
    pub recursive:Option<bool>, pub count_only:bool,
    pub date_field:String,
    pub limit:Option<usize>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all="camelCase")]
struct Info { date:Option<String>, date_source:String, object:String, theme:String }
fn year_regex()-> &'static Regex {static R:OnceLock<Regex>=OnceLock::new();R.get_or_init(||Regex::new(r"^(20\d{2}|19\d{2})年?$").unwrap())}
fn date_regex()-> &'static Regex {static R:OnceLock<Regex>=OnceLock::new();R.get_or_init(||Regex::new(r"(?:^|[^0-9])(?:(20\d{2}|19\d{2})[年./\-]?)?(\d{1,2})[月./\-](\d{1,2})(?:日|[^0-9]|$)").unwrap())}
fn compact_date_regex()-> &'static Regex {static R:OnceLock<Regex>=OnceLock::new();R.get_or_init(||Regex::new(r"(?:^|[^0-9])((?:20|19)\d{2})(\d{2})(\d{2})(?:[^0-9]|$)").unwrap())}
fn directory_date(name:&str,year:Option<i32>)->Option<NaiveDate>{
    if let Some(c)=compact_date_regex().captures(name){return NaiveDate::from_ymd_opt(c[1].parse().ok()?,c[2].parse().ok()?,c[3].parse().ok()?);}
    let c=date_regex().captures(name)?;
    NaiveDate::from_ymd_opt(c.get(1).and_then(|x|x.as_str().parse().ok()).or(year)?,c[2].parse().ok()?,c[3].parse().ok()?)
}
fn info(entry:&Entry,dirs:&HashMap<&str,&Entry>,r:&Request)->Info{
    let folder=if entry.is_dir{entry.path.as_str()}else{entry.parent.as_str()};
    let segments=folder.split(['\\','/']).filter(|s|!s.is_empty()).collect::<Vec<_>>();
    let year_pos=segments.iter().rposition(|s|year_regex().is_match(s));
    let year=year_pos.and_then(|p|segments[p].trim_end_matches('年').parse().ok());
    let dated=segments.iter().rev().find_map(|s|directory_date(s,year));
    let root_parts=r.root.as_deref().map(|s|s.split(['\\','/']).filter(|s|!s.is_empty()).count()).unwrap_or(0);
    let object=r.object_level.and_then(|l|segments.get(root_parts+l)).map(|s|s.to_string())
        .or_else(||year_pos.and_then(|p|p.checked_sub(1)).map(|p|segments[p].to_string())).unwrap_or_else(||"未归类".into());
    let theme=r.theme_level.and_then(|l|segments.get(root_parts+l)).map(|s|s.to_string())
        .or_else(||year_pos.and_then(|p|segments.get(p+1)).map(|s|s.to_string())).unwrap_or_else(||"未归类".into());
    if let Some(date)=dated {return Info{date:Some(date.to_string()),date_source:"目录名称".into(),object,theme};}
    let created=if entry.is_dir{entry.created}else{dirs.get(folder).and_then(|e|e.created)};
    let date=created.and_then(|n|DateTime::from_timestamp(n as i64,0)).map(|t|t.with_timezone(&Local).date_naive().to_string());
    Info{date_source:if date.is_some(){"文件夹创建日期"}else{"日期未知"}.into(),date,object,theme}
}
pub fn execute(index:&Index,mut r:Request,analysis:bool)->Result<Value,String>{
    let limit=r.limit.unwrap_or(10);execute_inner(index,&mut r,analysis,limit)
}
pub fn execute_full(index:&Index,mut r:Request,analysis:bool)->Result<Value,String>{
    execute_inner(index,&mut r,analysis,usize::MAX)
}
fn execute_inner(index:&Index,r:&mut Request,analysis:bool,limit:usize)->Result<Value,String>{
    if r.query.len()>500{return Err("查询关键词过长，请缩短后重试".into());}
    if !["","created","modified","businessDate"].contains(&r.date_field.as_str()){return Err("时间依据必须是系统创建时间、修改时间或业务日期".into());}
    if !["","file","directory","both"].contains(&r.kind.as_str()) || !["","relevance","latest","modified"].contains(&r.sort.as_str()) || !["","year","month","day","object","theme","extension"].contains(&r.group_by.as_str()){return Err("查询类型、排序或统计维度无效".into());}
    if r.limit.is_some_and(|n|n==0||n>50){return Err("每次展示数量必须为 1–50 项".into());}
    if r.object_level.is_some_and(|v|v>30)||r.theme_level.is_some_and(|v|v>30)||r.offset>1_000_000{return Err("目录层级或分页范围无效".into());}
    for date in [&r.after,&r.before].into_iter().flatten(){NaiveDate::parse_from_str(date,"%Y-%m-%d").map_err(|_|"时间范围必须是有效的年月日")?;}
    if r.after.as_ref().zip(r.before.as_ref()).is_some_and(|(a,b)|a>b){return Err("开始日期不能晚于结束日期".into());}
    if let Some(root)=&r.root{r.root=Some(index.authorize(root)?.to_string_lossy().into_owned());}
    let roots=index.roots.read().unwrap();let entries=index.entries.read().unwrap();
    let dirs=entries.iter().filter(|e|e.is_dir).map(|e|(e.path.as_str(),e)).collect::<HashMap<_,_>>();
    let tokens=r.query.to_lowercase().split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    let mut cache=HashMap::<String,Info>::new();let mut seen=HashSet::new();let mut rows=Vec::new();let mut groups=BTreeMap::<String,usize>::new();let mut unknown=0;
    for e in entries.iter(){
        if !roots.iter().any(|root|Path::new(&e.path).starts_with(root)) || r.root.as_ref().is_some_and(|root|if r.recursive.unwrap_or(true){!Path::new(&e.path).starts_with(root)||Path::new(&e.path)==Path::new(root)}else{Path::new(&e.parent)!=Path::new(root)}) || temporary_name(&e.name){continue;}
        if (r.kind=="file"||r.kind.is_empty())&&e.is_dir || r.kind=="directory"&&!e.is_dir{continue;}
        let extension=r.extension.trim_start_matches('.');
        if !extension.is_empty() && !(if extension.eq_ignore_ascii_case("excel"){["xls","xlsx","xlsm","xlsb"].iter().any(|ext|e.extension.eq_ignore_ascii_case(ext))}else{e.extension.eq_ignore_ascii_case(extension)}){continue;}
        if !tokens.iter().all(|t|if r.name_only{e.name.to_lowercase().contains(t)}else{e.searchable.contains(t)}) || !seen.insert(e.path.as_str()){continue;}
        let folder=if e.is_dir{&e.path}else{&e.parent};let inf=cache.entry(folder.clone()).or_insert_with(||info(e,&dirs,&r));
        let date=if r.date_field=="created"{e.created.and_then(|n|DateTime::from_timestamp(n as i64,0)).map(|t|t.with_timezone(&Local).date_naive().to_string())}
            else if r.date_field=="modified"||r.date_field.is_empty()&&r.sort=="modified"{DateTime::from_timestamp(e.modified as i64,0).map(|t|t.with_timezone(&Local).date_naive().to_string())}else{inf.date.clone()};
        if (r.after.is_some()||r.before.is_some())&&date.is_none(){unknown+=1;continue;}
        if date.as_ref().is_some_and(|d|r.after.as_ref().is_some_and(|a|d<a)||r.before.as_ref().is_some_and(|b|d>b)){continue;}
        let key=match r.group_by.as_str(){"object"=>inf.object.clone(),"theme"=>inf.theme.clone(),"extension"=>e.extension.clone(),"month"=>date.as_ref().map(|d|d[..7].into()).unwrap_or("未归类".into()),"day"=>date.clone().unwrap_or("未归类".into()),_=>date.as_ref().map(|d|d[..4].into()).unwrap_or("未归类".into())};
        *groups.entry(key).or_default()+=1;
        if date.is_none(){unknown+=1;}
        let name=e.name.to_lowercase();let score=tokens.iter().map(|t|if name==*t{100}else if name.contains(t){60}else if inf.theme.to_lowercase().contains(t)||inf.object.to_lowercase().contains(t){30}else{10}).sum::<u32>();
        rows.push((e,inf.clone(),date,score));
    }
    rows.sort_unstable_by(|a,b|{
        let date_order=||if r.sort=="modified"||r.date_field=="modified"{b.0.modified.cmp(&a.0.modified)}else if r.date_field=="created"{b.0.created.cmp(&a.0.created)}else{b.2.cmp(&a.2)};
        (if ["latest","modified"].contains(&r.sort.as_str()){date_order().then_with(||b.3.cmp(&a.3))}else{b.3.cmp(&a.3).then_with(date_order)}).then_with(||a.0.sort_key.cmp(&b.0.sort_key)).then_with(||a.0.path.cmp(&b.0.path))
    });
    let latest=rows.iter().filter_map(|r|r.2.clone()).max();
    let timestamp_field=if r.sort=="modified"||r.date_field=="modified"{Some("modified")}else if r.date_field=="created"{Some("created")}else{None};
    let latest_timestamp=timestamp_field.and_then(|field|rows.iter().filter_map(|row|if field=="created"{row.0.created}else{Some(row.0.modified)}).max());
    let latest_match_count=rows.iter().filter(|row|if let Some(field)=timestamp_field{latest_timestamp.is_some()&&(if field=="created"{row.0.created}else{Some(row.0.modified)})==latest_timestamp}else{latest.is_some()&&row.2==latest}).count();
    if r.latest_only{if let Some(field)=timestamp_field{rows.retain(|row|latest_timestamp.is_some()&&(if field=="created"{row.0.created}else{Some(row.0.modified)})==latest_timestamp);}else if let Some(date)=&latest{rows.retain(|row|row.2.as_ref()==Some(date));}else{rows.clear();}
        groups.clear();for (e,inf,date,_) in &rows{let key=match r.group_by.as_str(){"object"=>inf.object.clone(),"theme"=>inf.theme.clone(),"extension"=>e.extension.clone(),"month"=>date.as_ref().map(|d|d[..7].into()).unwrap_or("未归类".into()),"day"=>date.clone().unwrap_or("未归类".into()),_=>date.as_ref().map(|d|d[..4].into()).unwrap_or("未归类".into())};*groups.entry(key).or_default()+=1;}}
    let total=rows.len();let earliest=rows.iter().filter_map(|r|r.2.clone()).min();
    let items=rows.into_iter().skip(r.offset).take(if limit!=usize::MAX&&r.count_only{0}else{limit}).map(|(e,inf,date,score)|{let mut v=serde_json::to_value(e).unwrap();v["businessDate"]=json!(inf.date);v["dateSource"]=json!(inf.date_source);v["selectedDate"]=json!(date);v["object"]=json!(inf.object);v["theme"]=json!(inf.theme);v["relevance"]=json!(score);v["matchReason"]=json!(if score>=60{"文件名匹配"}else if score>=30{"业务目录匹配"}else{"上级路径匹配"});v}).collect::<Vec<_>>();
    let status=index.status.lock().unwrap();
    Ok(json!({"items":items,"total":total,"latestDate":latest,"latestTimestamp":latest_timestamp,"latestMatchCount":latest_match_count,"timePrecision":if timestamp_field.is_some(){"second"}else{"day"},"earliestDate":earliest,"groups":groups.into_iter().map(|(label,count)|json!({"label":label,"count":count})).collect::<Vec<_>>(),"unknownDateCount":unknown,"scope":{"root":r.root,"query":r.query,"kind":r.kind,"recursive":r.recursive.unwrap_or(true),"extension":r.extension,"indexGeneration":status.generation,"indexScanning":status.scanning,"indexErrors":status.errors},"request":r,"analysis":analysis,"countUnit":if r.kind=="directory"{"文件夹数量"}else if r.kind=="both"{"文件和文件夹数量"}else{"每个命中的业务文件分别计数，不代表已证实的操作次数"},"hasMore":!r.count_only&&total>r.offset+r.limit.unwrap_or(10)}))
}
// 只在原快照成员中排序和筛选，追问不能借此扩大目录或换成新文件。
pub fn order_snapshot(result:&mut Value,request:&Request)->Result<(),String>{
    if !["","relevance","latest","modified"].contains(&request.sort.as_str())||!["","created","modified","businessDate"].contains(&request.date_field.as_str())||request.limit.is_some_and(|n|n==0||n>50){return Err("原集合排序、时间依据或展示数量无效".into());}
    let field=if request.sort=="modified"||request.date_field=="modified"{"modified"}else if request.date_field=="created"{"created"}else{"businessDate"};
    let rows=result["items"].as_array_mut().ok_or("结果不是文件集合")?;
    let key=|row:&Value|if field=="businessDate"{row[field].as_str().map(str::to_owned)}else{row[field].as_u64().map(|n|format!("{n:020}"))};
    if ["latest","modified"].contains(&request.sort.as_str()){
        rows.sort_by(|a,b|key(b).cmp(&key(a)).then_with(||a["name"].as_str().cmp(&b["name"].as_str())).then_with(||a["path"].as_str().cmp(&b["path"].as_str())));
    }
    let latest=rows.iter().filter_map(key).max();let matches=rows.iter().filter(|row|latest.is_some()&&key(row)==latest).count();
    let unknown=rows.iter().filter(|row|key(row).is_none()).count();
    if request.latest_only{rows.retain(|row|latest.is_some()&&key(row)==latest);}
    let total=rows.len();
    let timestamp=if field=="businessDate"{None}else{rows.iter().filter_map(|r|r[field].as_u64()).max()};
    result["total"]=json!(total);result["latestMatchCount"]=json!(matches);result["latestTimestamp"]=json!(timestamp);result["timePrecision"]=json!(if field=="businessDate"{"day"}else{"second"});result["unknownDateCount"]=json!(unknown);
    result["latestDate"]=json!(if field=="businessDate"{latest}else{timestamp.and_then(|n|DateTime::from_timestamp(n as i64,0)).map(|d|d.with_timezone(&Local).date_naive().to_string())});
    if request.latest_only{result["groups"]=json!([]);}
    result["request"]=json!(request);Ok(())
}
pub fn answer(result:&Value)->String{
    let total=result["total"].as_u64().unwrap_or(0);
    if result["request"]["countOnly"]==true{
        let unit=match result["request"]["kind"].as_str(){Some("directory")=>"文件夹",Some("both")=>"文件或文件夹",_=>if result["request"]["extension"].as_str().is_some_and(|e|e.eq_ignore_ascii_case("excel")){"表格工作簿"}else{"文件"}};
        let mut text=format!("该目录下共有 {total} 个{unit}。\n\n统计范围：{}，仅统计已索引项目。",if result["scope"]["recursive"]==false{"仅当前层，不含子目录"}else{"包含子目录，不计所选目录本身"});
        if result["scope"]["indexScanning"]==true{text.push_str("索引仍在更新，数量可能继续变化。");}
        if result["scope"]["indexErrors"].as_array().is_some_and(|errors|!errors.is_empty()){text.push_str("部分目录索引失败，数量可能不完整。");}
        return text;
    }
    if total==0{return format!("没有找到符合条件的{}。{}{}",if result["request"]["kind"]=="directory"{"文件夹"}else{"文件"},if result["unknownDateCount"].as_u64().unwrap_or(0)>0{"存在日期未知的候选，未计入日期筛选结果。"}else{""},if result["scope"]["indexScanning"]==true{"索引仍在更新，结果仅覆盖当前已索引范围。"}else{""});}
    let latest=result["latestDate"].as_str().unwrap_or("日期未知");
    let mut text=if result["analysis"]==true&&result["request"]["kind"]!="directory"&&result["request"]["kind"]!="both"{format!("找到 {total} 个相关业务文件；最新目录记录日期为 {latest}。\n\n按业务文件计数，不同格式分别计算，不能据此确认实际操作次数。")}
        else{format!("找到 {total} 个匹配{}，以下展示 {} 项。",if result["request"]["kind"]=="directory"{"文件夹"}else if result["request"]["kind"]=="both"{"文件或文件夹"}else{"文件"},result["items"].as_array().map_or(0,Vec::len))};
    if result["analysis"]==true&&!result["request"]["groupBy"].as_str().unwrap_or("").is_empty(){
        text.push_str("\n\n| 分组 | 文件数 |\n| --- | ---: |\n");
        for g in result["groups"].as_array().into_iter().flatten(){text.push_str(&format!("| {} | {} |\n",g["label"].as_str().unwrap_or("").replace('|',"／"),g["count"]));}
    }
    if result["unknownDateCount"].as_u64().unwrap_or(0)>0{text.push_str(&format!("\n\n{} 个文件的日期无法判断；有日期筛选时这些文件未计入筛选结果。",result["unknownDateCount"]));}
    if result["scope"]["indexScanning"]==true{text.push_str("\n\n索引仍在更新，以上为当前已索引范围的结果。");}
    text
}
