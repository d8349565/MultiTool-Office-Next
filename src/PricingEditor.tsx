import { useState } from 'react';
import { Button } from '@fluentui/react-components';
import { Plus, Trash } from '@phosphor-icons/react';
import defaults from './assistantPricingDefaults.json';
import type { PricingConfig, PricingRule } from './types';

export function PricingEditor({value,modelId,modelUrl,onChange}:{value?:PricingConfig;modelId:string;modelUrl:string;onChange:(v:PricingConfig)=>void}){
  const config=value??defaults as PricingConfig;
  let host='';try{host=new URL(modelUrl).hostname;}catch{}
  const [chosen,setChosen]=useState(()=>config.rules.find(r=>r.providerHost===host&&r.modelIds.includes(modelId))?.id||config.rules[0]?.id||'');
  const [year,setYear]=useState(String(new Date().getFullYear()+1));
  const rule=config.rules.find(r=>r.id===chosen)||config.rules[0];
  const edit=<K extends keyof PricingRule>(key:K,v:PricingRule[K])=>onChange({...config,rules:config.rules.map(r=>r.id===rule.id?{...r,[key]:v}:r)});
  function add(){const next:PricingRule={id:crypto.randomUUID(),modelIds:modelId?[modelId]:[],providerHost:host,currency:'CNY',inputPerMillion:0,cachedInputPerMillion:0,outputPerMillion:0,schedule:'flat',offPeakDiscount:1,source:'',verifiedAt:new Date().toLocaleDateString('en-CA')};onChange({...config,rules:[...config.rules,next]});setChosen(next.id);}
  function rate(key:'inputPerMillion'|'cachedInputPerMillion'|'outputPerMillion',label:string){return <label>{label}<input required type="number" min={0} max={1000000} step="any" value={Number.isFinite(rule[key])?rule[key]:''} onChange={e=>edit(key,e.target.value===''?NaN:Number(e.target.value))}/></label>;}
  return <>
    <section className="settings-section pricing-editor"><h3>模型单价</h3><p>以每百万 token 为单位。默认内置 DeepSeek 官方人民币价格（2026-10-08 核对）；其他服务按各自单价填写。</p>
      <div className="pricing-rule-picker"><label>计价规则<select value={rule?.id||''} onChange={e=>setChosen(e.target.value)}><option value="" disabled>选择模型</option>{config.rules.map(r=><option key={r.id} value={r.id}>{r.modelIds.join(' / ')||'待填写模型'} · {r.currency}</option>)}</select></label><Button type="button" icon={<Plus/>} onClick={add}>新增</Button></div>
      {rule&&<><div className="form-grid"><label>模型 ID / 别名<input required value={rule.modelIds.join(', ')} onChange={e=>edit('modelIds',e.target.value.split(',').map(s=>s.trim()))}/><small>多个别名用英文逗号分隔。</small></label><label>服务域名<input required value={rule.providerHost} onChange={e=>edit('providerHost',e.target.value.trim().toLowerCase())} placeholder="api.deepseek.com"/><small>精确匹配服务，避免把代理服务按官方价计费。</small></label><label>币种<select value={rule.currency} onChange={e=>edit('currency',e.target.value as PricingRule['currency'])}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></label><label>计费时段<select value={rule.schedule} onChange={e=>edit('schedule',e.target.value as PricingRule['schedule'])}><option value="flat">固定单价</option><option value="deepseek">DeepSeek 峰谷时段</option></select></label></div>
        <div className="pricing-rates">{rate('inputPerMillion','未缓存输入')}{rate('cachedInputPerMillion','缓存命中输入')}{rate('outputPerMillion','输出')}</div>
        {rule.schedule==='deepseek'&&<div className="pricing-schedule"><label>空闲时段折扣<input required type="number" min={0} max={1} step="any" value={Number.isFinite(rule.offPeakDiscount)?rule.offPeakDiscount:''} onChange={e=>edit('offPeakDiscount',e.target.value===''?NaN:Number(e.target.value))}/></label><p>上方填写高峰单价。北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，节假日除外；其余时间乘以折扣（官方为 0.5）。</p></div>}
        <div className="form-grid"><label>计价来源<input required value={rule.source} onChange={e=>edit('source',e.target.value)} placeholder="官方网页或用户提供的价格说明"/></label><label>核对日期<input required type="date" value={rule.verifiedAt} onChange={e=>edit('verifiedAt',e.target.value)}/></label></div>
        <Button type="button" appearance="subtle" icon={<Trash/>} onClick={()=>onChange({...config,rules:config.rules.filter(r=>r.id!==rule.id)})}>移除此计价规则</Button></>}
    </section>
    <details className="settings-advanced pricing-calendar"><summary>峰谷计费节假日</summary><p>按北京时间填写各年的完整假期日期。缺少年份时，高峰时间的请求会显示无法计费。默认内置 2026 年国务院放假安排。</p>{Object.entries(config.holidays).map(([y,dates])=><label key={y}>{y} 年 · {dates.filter(Boolean).length} 天<textarea value={dates.join('\n')} onChange={e=>onChange({...config,holidays:{...config.holidays,[y]:e.target.value.split(/[\n,]/).map(s=>s.trim())}})} aria-label={y+' 年节假日日期'} placeholder="YYYY-MM-DD，每行一个日期"/><Button type="button" appearance="subtle" onClick={()=>{const holidays={...config.holidays};delete holidays[y];onChange({...config,holidays});}}>移除 {y} 年</Button></label>)}<div className="button-row"><label>新增年份<input type="number" min={2020} max={2100} value={year} onChange={e=>setYear(e.target.value)}/></label><Button type="button" disabled={!/^(?:20\d{2}|2100)$/.test(year)||year in config.holidays} onClick={()=>onChange({...config,holidays:{...config.holidays,[year]:[]}})}>添加年份</Button></div></details>
    <p className="pricing-save-hint">保存后用于下一次任务。助手更新价格时会先整理建议与来源，由你确认后应用；历史费用保留原单价。</p>
  </>;
}
