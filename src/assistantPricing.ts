import { usageRequests } from './assistantMetrics';
import type { PricingRule, Proposal, Settings } from './types';

export const hasPricingChange=(p:Proposal)=>JSON.stringify(p.before.modelPricing)!==JSON.stringify(p.after.modelPricing);
export function proposalMatchesSettings(p:Proposal,settings:Settings):boolean{
  const keys=(Object.keys(p.after) as (keyof Settings)[]).filter(k=>k in settings&&JSON.stringify(p.before[k])!==JSON.stringify(p.after[k]));
  return keys.length>0&&keys.every(k=>JSON.stringify(settings[k])===JSON.stringify(p.after[k]));
}

export interface BillingRecord {status:'calculated'|'unavailable';reason?:string;model?:string;requestedAt?:number;revision?:number;currency?:'CNY'|'USD';period?:'flat'|'peak'|'off_peak';rule?:PricingRule;inputTokens?:number;cachedTokens?:number;outputTokens?:number;inputCost?:number;cachedCost?:number;outputCost?:number;total?:number}
export interface CostTotal {currency:'CNY'|'USD';total:number;inputCost:number;cachedCost:number;outputCost:number;requests:number}
export const billingReasons:Record<string,string>={missing_rate:'模型或服务尚未配置单价',missing_calendar:'缺少请求年份的节假日配置',missing_usage:'服务未返回完整 token / 缓存用量',invalid_usage:'服务返回的缓存用量不一致',request_failed:'请求未完成，无法核实扣费',legacy:'历史记录未保留当时的价格'};
const amount=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
// 只汇总原生层记录的费用快照，不用今天的单价重算旧请求，不混加不同币种。
export function costMetrics(raw:unknown){
  const totals:CostTotal[]=[];const records:BillingRecord[]=[];
  for(const request of usageRequests(raw)){
    const bill=request.billing as BillingRecord|undefined;
    if(!bill||typeof bill!=='object'){records.push({status:'unavailable',reason:'legacy'});continue;}
    const costs=[bill.total,bill.inputCost,bill.cachedCost,bill.outputCost];
    if(bill.status!=='calculated'||!['CNY','USD'].includes(bill.currency||'')||!costs.every(amount)||Math.abs(bill.total!-(bill.inputCost!+bill.cachedCost!+bill.outputCost!))>1e-8){records.push({...bill,status:'unavailable',reason:bill.reason||'invalid_usage'});continue;}
    records.push(bill);let total=totals.find(t=>t.currency===bill.currency);
    if(!total){total={currency:bill.currency!,total:0,inputCost:0,cachedCost:0,outputCost:0,requests:0};totals.push(total);}
    total.total+=bill.total!;total.inputCost+=bill.inputCost!;total.cachedCost+=bill.cachedCost!;total.outputCost+=bill.outputCost!;total.requests++;
  }
  return {totals,records,missing:records.filter(r=>r.status!=='calculated').length};
}
export function money(value:number,currency:'CNY'|'USD'):string{
  const symbol=currency==='CNY'?'¥':'$';
  return symbol+(value>0&&value<0.0001?'<0.0001':value.toFixed(4));
}
export const periodLabels={flat:'固定单价',peak:'高峰',off_peak:'空闲'};
