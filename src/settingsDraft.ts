import type { Settings } from './types';

export const searchSettingsKeys=['searchEnabled','searchProvider','deepseekSearchProfileId','deepseekFetchEnabled'] as const;
const searchDefaults:Partial<Settings>={searchEnabled:false,searchProvider:'tavily',deepseekSearchProfileId:null,deepseekFetchEnabled:false};
export function settingsFieldEqual(a:Settings,b:Settings,key:keyof Settings){
  return settingsEqual(key in searchDefaults?a[key]??searchDefaults[key]:a[key],key in searchDefaults?b[key]??searchDefaults[key]:b[key]);
}
export function searchSettingsChanged(a:Settings,b:Settings){return searchSettingsKeys.some(key=>!settingsFieldEqual(a,b,key));}

// 配置内容相同即视为已保存，不受后端 JSON 对象字段顺序影响。
export function settingsEqual(a:unknown,b:unknown){
  const serialize=(v:unknown)=>JSON.stringify(v,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
  return serialize(a)===serialize(b);
}
export function rebaseSettings(draft:Settings,before:Settings,after:Settings,savedKeys:readonly string[]=[]):Settings{
  const next={...draft};
  for(const key of Object.keys(after) as (keyof Settings)[]){
    if(key==='revision'||savedKeys.includes(key)||settingsFieldEqual(draft,before,key))Object.assign(next,{[key]:after[key]});
  }
  return next;
}
