// 用量来自服务返回；未知字段不按零计算。
export interface AssistantStats { round:number; steps:number; usage:unknown; contextLimit:number }
export interface TokenMetrics { read:number|null; cacheRate:number|null; written:number|null; speed:number|null; avgSpeed:number|null; contextTokens:number|null; rounds:number|null }
type RecordValue=Record<string,unknown>;
function record(value:unknown):RecordValue{return value&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};}
function count(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;}
// 一轮=模型针对本任务的一次完整尝试（理解需求算一轮；后续每次工具轮重试各算一轮；直答为 1 轮）。
// 步骤=实际执行过的工具操作次数。
// roundLabel 标记一条用量属于哪一轮；意图识别自成一轮，截断续写沿用所属轮次。
function roundLabel(item:RecordValue):string{
  if(typeof item.roundLabel==='string'&&item.roundLabel)return item.roundLabel;
  if(typeof item.kind==='string'&&item.kind)return item.kind;
  const round=count(item.round);
  return round===null?'agent':`round-${round}`;
}
function roundGroups(rows:RecordValue[]):number|null{
  if(!rows.length)return null;
  return new Set(rows.map(row=>roundLabel(row))).size;
}
// 会话累计时，各任务的轮次编号会重复（第 1 轮、第 2 轮……），必须按任务隔离后才不会互相覆盖。
export function withTaskScope(usage:unknown,scope:string):unknown{
  if(!Array.isArray(usage))return usage;
  return usage.map(entry=>{const item=record(entry);if(!('round' in item)&&!('kind' in item)&&!('requests' in item)&&!('roundLabel' in item))return entry;
    return {...item,roundLabel:`${roundLabel(item)}@${scope}`};});
}
export function usageRequests(raw:unknown):RecordValue[]{
  const requests:RecordValue[]=[];
  // requests 是同一轮内的多次请求（截断续写会多出几项），轮次归属必须继承外层标记。
  function visit(value:unknown,parent?:string){if(Array.isArray(value)){value.forEach(item=>visit(item,parent));return;}const item=record(value);
    if(Array.isArray(item.requests)&&item.requests.length){item.requests.forEach(child=>visit(child,roundLabel(item)));return;}
    if('usage' in item){requests.push(parent?{...item,roundLabel:parent}:item);return;}
    requests.push(parent?{usage:value,roundLabel:parent}:{usage:value});
  }
  if(raw!==undefined&&raw!==null)visit(raw);
  return requests;
}
export function tokenMetrics(raw:unknown):TokenMetrics{
  const requests=usageRequests(raw);
  const rows=requests.map(item=>{
    const row:RecordValue&{read:number|null;written:number|null;cached:number|null;ms:number|null;validUsage:boolean;hasCachedField:boolean}=item as never;
    if(item.usage===null||item.usage===undefined||typeof item.usage!=='object'){
      return {...row,read:null,written:null,cached:null,ms:count(item.generationMs),validUsage:false,hasCachedField:false};
    }
    const usage=record(item.usage),details=record(usage.prompt_tokens_details??usage.input_tokens_details);
    const read=count(usage.prompt_tokens??usage.input_tokens),written=count(usage.completion_tokens??usage.output_tokens);
    const rawCached=usage.prompt_cache_hit_tokens??details.cached_tokens??usage.cached_tokens??usage.cache_read_input_tokens??details.cache_read_input_tokens??details.cache_read;
    const hasCachedField=rawCached!==undefined&&rawCached!==null;
    const parsedCached=count(rawCached);
    const cached=parsedCached!==null&&read!==null&&parsedCached<=read?parsedCached:null;
    return {...row,read,written,cached,ms:count(item.generationMs),validUsage:true,hasCachedField};
  });
  const rounds=roundGroups(rows);
  if(!rows.length)return {read:null,written:null,cacheRate:null,speed:null,avgSpeed:null,contextTokens:null,rounds:null};
  const anyUsageInvalid=rows.some(r=>!r.validUsage||r.read===null||r.written===null);
  const read=anyUsageInvalid?null:rows.reduce((total,r)=>total+r.read!,0);
  const written=anyUsageInvalid?null:rows.reduce((total,r)=>total+r.written!,0);
  let cacheRate:number|null=null;
  const anyCachedReported=rows.some(r=>r.hasCachedField);
  const anyCachedCorrupted=rows.some(r=>r.hasCachedField&&r.cached===null);
  if(anyCachedReported&&!anyCachedCorrupted&&read!==null){
    const totalCached=rows.reduce((total,r)=>total+(r.cached??0),0);
    cacheRate=read>0?(totalCached/read)*100:0;
  }
  // 100ms 以下的“生成时长”多为非流式一次性返回的测量噪声，排除后才不会污染速度。
  const validSpeedRows=rows.filter(r=>r.ms!==null&&r.ms>=100&&r.written!==null);
  const rate=(row:{written:number|null;ms:number|null})=>row.written!==null&&row.ms!==null&&row.ms>0?(row.written*1000)/row.ms:null;
  const speed=validSpeedRows.length?rate(validSpeedRows[validSpeedRows.length-1]):null;
  let avgSpeed:number|null=null;
  if(validSpeedRows.length>0){
    const totalMs=validSpeedRows.reduce((total,r)=>total+r.ms!,0);
    const totalWritten=validSpeedRows.reduce((total,r)=>total+r.written!,0);
    avgSpeed=totalMs>0?(totalWritten*1000)/totalMs:null;
  }
  // 上下文占用：历史在每次请求中不断累积，取整段对话中最大的一次请求（输入+输出）才代表当前占用。
  const contextTokens=rows.reduce<number|null>((peak,r)=>r.read!==null&&r.written!==null?Math.max(peak??0,r.read+r.written):peak,null);
  return {read,written,cacheRate,speed,avgSpeed,contextTokens,rounds};
}
export function contextCapacity(configured:number|undefined,modelId:string):number{
  if(configured&&Number.isFinite(configured)&&configured>0)return configured;
  // 用户提供的模型规格：DeepSeek Flash / V4 为 1M；其他模型需填写容量。
  return /^deepseek-(?:flash|v4)(?:$|[-.(])/i.test(modelId.trim())?1_000_000:0;
}
export function compactTokens(value:number|null):string{
  if(value===null)return '—';
  if(value>=1_000_000)return (value/1_000_000).toFixed(value>=10_000_000?0:1).replace(/\.0$/,'')+'M';
  if(value>=1_000)return (value/1_000).toFixed(value>=100_000?0:1).replace(/\.0$/,'')+'k';
  return String(Math.round(value));
}
export function percent(value:number|null):string{return value===null?'—':value===0?'0%':value<0.1?'<0.1%':value.toFixed(1).replace(/\.0$/,'')+'%';}
