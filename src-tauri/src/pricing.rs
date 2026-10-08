use chrono::{Datelike, FixedOffset, NaiveDate, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct PricingRule {
    pub id:String, pub model_ids:Vec<String>, pub provider_host:String, pub currency:String,
    pub input_per_million:f64, pub cached_input_per_million:f64, pub output_per_million:f64,
    pub schedule:String, pub off_peak_discount:f64, pub source:String, pub verified_at:String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct PricingConfig {pub rules:Vec<PricingRule>, pub holidays:BTreeMap<String,Vec<String>>}
impl Default for PricingConfig {
    fn default()->Self{serde_json::from_str(include_str!("../../src/assistantPricingDefaults.json")).expect("built-in pricing")}
}
pub fn validate(config:&PricingConfig)->Result<(),String>{
    if config.rules.len()>100||config.holidays.len()>20{return Err("计价规则或节假日年份过多".into());}
    let mut ids=HashSet::new();let mut models=HashSet::new();
    for r in &config.rules {
        if r.id.trim().is_empty()||r.id.len()>100||!ids.insert(&r.id)||r.model_ids.is_empty()||r.model_ids.len()>30{return Err("计价规则需要唯一 ID 和模型名称".into());}
        let host=reqwest::Url::parse(&format!("https://{}",r.provider_host)).map_err(|_|"计价服务域名无效")?;
        if host.host_str()!=Some(r.provider_host.as_str())||host.path()!="/"||host.port().is_some()||!host.username().is_empty()||host.password().is_some()||host.query().is_some()||host.fragment().is_some(){return Err("计价服务只填写小写域名，不含协议、端口或路径".into());}
        if !["CNY","USD"].contains(&r.currency.as_str())||!["flat","deepseek"].contains(&r.schedule.as_str()){return Err("计价币种或时段规则无效".into());}
        if [r.input_per_million,r.cached_input_per_million,r.output_per_million].iter().any(|n|!n.is_finite()||*n<0.0||*n>1_000_000.0)||!r.off_peak_discount.is_finite()||!(0.0..=1.0).contains(&r.off_peak_discount){return Err("每百万标记单价必须为 0–1000000，空闲折扣为 0–1".into());}
        if r.source.trim().is_empty()||r.source.len()>2000||NaiveDate::parse_from_str(&r.verified_at,"%Y-%m-%d").is_err(){return Err("请注明计价来源与核对日期（YYYY-MM-DD）".into());}
        for model in &r.model_ids {if model.trim().is_empty()||model.trim()!=model||model.len()>200||!models.insert((r.provider_host.as_str(),model.to_ascii_lowercase())){return Err("同一服务的模型计价不能重复".into());}}
    }
    for (year,dates) in &config.holidays {
        if year.len()!=4||year.parse::<u32>().is_err()||dates.is_empty()||dates.len()>366||dates.iter().any(|d|NaiveDate::parse_from_str(d,"%Y-%m-%d").is_err()||!d.starts_with(&format!("{year}-"))){return Err("节假日请按年份填写完整有效日期，不可只添加空年份".into());}
    }
    Ok(())
}
fn token(value:&Value)->Option<u64>{value.as_u64().filter(|n|*n<=1_000_000_000)}
fn period(config:&PricingConfig,r:&PricingRule,requested_at:i64)->Option<(&'static str,f64)>{
    if r.schedule=="flat"{return Some(("flat",1.0));}
    let dt=FixedOffset::east_opt(8*3600)?.timestamp_millis_opt(requested_at).single()?;
    if dt.weekday().number_from_monday()>5||!((9..12).contains(&dt.hour())||(14..18).contains(&dt.hour())){return Some(("off_peak",r.off_peak_discount));}
    // 未提供该年节假日时，不能把工作日高峰时间猜成高峰计费。
    let holidays=config.holidays.get(&dt.year().to_string())?;
    if holidays.contains(&dt.format("%Y-%m-%d").to_string()){Some(("off_peak",r.off_peak_discount))}else{Some(("peak",1.0))}
}
// 原生层在每次请求完成时记录价格与费用，后续配置修改不重算历史。
pub fn snapshot(config:&PricingConfig,url:&str,model:&str,usage:&Value,requested_at:i64,revision:u64)->Value{
    let mut result=json!({"model":model,"requestedAt":requested_at,"revision":revision,"status":"unavailable"});
    let host=reqwest::Url::parse(url).ok().and_then(|u|u.host_str().map(str::to_owned));
    let Some(r)=config.rules.iter().find(|r|Some(r.provider_host.as_str())==host.as_deref()&&r.model_ids.iter().any(|id|id.eq_ignore_ascii_case(model)))else{result["reason"]=json!("missing_rate");return result;};
    result["rule"]=json!(r);result["currency"]=json!(r.currency);
    let Some((period,factor))=period(config,r,requested_at)else{result["reason"]=json!("missing_calendar");return result;};
    result["period"]=json!(period);
    let input=token(&usage["prompt_tokens"]).or_else(||token(&usage["input_tokens"]));
    let output=token(&usage["completion_tokens"]).or_else(||token(&usage["output_tokens"]));
    let hit=token(&usage["prompt_cache_hit_tokens"]).or_else(||token(&usage["prompt_tokens_details"]["cached_tokens"])).or_else(||token(&usage["input_tokens_details"]["cached_tokens"])).or_else(||token(&usage["cached_tokens"]));
    let miss=token(&usage["prompt_cache_miss_tokens"]);
    let hit=hit.or_else(||input.zip(miss).and_then(|(i,m)|i.checked_sub(m))).or_else(||if r.input_per_million==r.cached_input_per_million{Some(0)}else{None});
    let Some((input,output,hit))=input.zip(output).zip(hit).map(|((i,o),h)|(i,o,h))else{result["reason"]=json!("missing_usage");return result;};
    if hit>input||miss.is_some_and(|m|m!=input-hit){result["reason"]=json!("invalid_usage");return result;}
    let input_cost=(input-hit) as f64*r.input_per_million*factor/1_000_000.0;
    let cached_cost=hit as f64*r.cached_input_per_million*factor/1_000_000.0;
    let output_cost=output as f64*r.output_per_million*factor/1_000_000.0;
    result["status"]=json!("calculated");result["inputTokens"]=json!(input-hit);result["cachedTokens"]=json!(hit);result["outputTokens"]=json!(output);
    result["inputCost"]=json!(input_cost);result["cachedCost"]=json!(cached_cost);result["outputCost"]=json!(output_cost);result["total"]=json!(input_cost+cached_cost+output_cost);
    result
}
pub fn schema()->Value{json!({"type":"object","properties":{
    "rules":{"type":"array","maxItems":100,"items":{"type":"object","properties":{
        "id":{"type":"string"},"modelIds":{"type":"array","items":{"type":"string"}},"providerHost":{"type":"string"},"currency":{"type":"string","enum":["CNY","USD"]},
        "inputPerMillion":{"type":"number","minimum":0},"cachedInputPerMillion":{"type":"number","minimum":0},"outputPerMillion":{"type":"number","minimum":0},
        "schedule":{"type":"string","enum":["flat","deepseek"]},"offPeakDiscount":{"type":"number","minimum":0,"maximum":1},"source":{"type":"string"},"verifiedAt":{"type":"string"}
    },"required":["id","modelIds","providerHost","currency","inputPerMillion","cachedInputPerMillion","outputPerMillion","schedule","offPeakDiscount","source","verifiedAt"],"additionalProperties":false}},
    "holidays":{"type":"object","additionalProperties":{"type":"array","items":{"type":"string"}}}
},"required":["rules","holidays"],"additionalProperties":false})}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(date:&str)->i64{chrono::DateTime::parse_from_rfc3339(date).unwrap().timestamp_millis()}
    fn charge(config:&PricingConfig,date:&str)->Value{snapshot(config,"https://api.deepseek.com/v1","deepseek-flash",&json!({"prompt_tokens":1_000_000,"prompt_cache_hit_tokens":400_000,"prompt_cache_miss_tokens":600_000,"completion_tokens":100_000}),at(date),7)}
    #[test] fn peak_holiday_and_boundary_costs(){
        let config=PricingConfig::default();validate(&config).unwrap();
        let peak=charge(&config,"2026-10-08T09:00:00+08:00");assert!((peak["total"].as_f64().unwrap()-2.016).abs()<1e-10);
        for date in ["2026-10-08T08:59:59+08:00","2026-10-08T12:00:00+08:00","2026-10-08T18:00:00+08:00","2026-10-01T10:00:00+08:00","2026-10-10T10:00:00+08:00"]{let v=charge(&config,date);assert_eq!(v["period"],"off_peak");assert!((v["total"].as_f64().unwrap()-1.008).abs()<1e-10);}
    }
    #[test] fn missing_or_inconsistent_data_is_never_zero_cost(){
        let config=PricingConfig::default();let date=at("2026-10-08T10:00:00+08:00");
        for usage in [json!({}),json!({"prompt_tokens":10,"completion_tokens":1}),json!({"prompt_tokens":10,"completion_tokens":1,"prompt_cache_hit_tokens":11}),json!({"prompt_tokens":10,"completion_tokens":1,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":7})]{assert!(snapshot(&config,"https://api.deepseek.com","deepseek-flash",&usage,date,0)["total"].is_null());}
        assert_eq!(charge(&config,"2027-01-04T10:00:00+08:00")["reason"],"missing_calendar");
        assert_eq!(snapshot(&config,"https://reseller.example","deepseek-flash",&json!({}),date,0)["reason"],"missing_rate");
    }
    #[test] fn alias_zero_flat_and_snapshot_stability(){
        let mut config=PricingConfig::default();let original=charge(&config,"2026-10-08T10:00:00+08:00");
        config.rules[0].input_per_million=20.0;assert_ne!(charge(&config,"2026-10-08T10:00:00+08:00")["total"],original["total"]);assert_eq!(original["rule"]["inputPerMillion"].as_f64(),Some(2.0));
        let zero=json!({"prompt_tokens":0,"completion_tokens":0,"prompt_cache_hit_tokens":0});assert_eq!(snapshot(&config,"https://api.deepseek.com","deepseek-v4-flash",&zero,at("2026-10-08T10:00:00+08:00"),0)["total"],0.0);
        config.rules[0].schedule="flat".into();config.rules[0].cached_input_per_million=20.0;assert_eq!(snapshot(&config,"https://api.deepseek.com","deepseek-flash",&json!({"prompt_tokens":10,"completion_tokens":1}),0,0)["status"],"calculated");
        config.rules.push(config.rules[0].clone());assert!(validate(&config).is_err());
    }
}
