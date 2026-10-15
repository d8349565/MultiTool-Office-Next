import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { Plus } from '@phosphor-icons/react';
import { api } from './api';
import { KeyGuide } from './ServiceGuide';
import type { ModelProfile, Settings } from './types';

type TestResult={model:string;text:string;elapsedMs:number;endpoint:string};
type Tested={settings:Settings;result:TestResult;profileId:string};
function profiles(settings:Settings):ModelProfile[]{
  const list=[...(settings.modelProfiles||[])];
  if(!settings.activeModelProfileId&&settings.modelUrl&&settings.modelId&&!list.some(p=>p.id==='legacy'))list.unshift({id:'legacy',name:'原有模型配置',modelUrl:settings.modelUrl,modelId:settings.modelId});
  return list;
}
const empty={name:'DeepSeek',modelUrl:'https://api.deepseek.com',modelId:'deepseek-flash'};

export function ModelConnections({settings,onSaved,onDirtyChange,onBusyChange,disabled}:{settings:Settings;onSaved:(s:Settings)=>void;onDirtyChange:(v:boolean)=>void;onBusyChange:(v:boolean)=>void;disabled:boolean}){
  const list=profiles(settings),active=settings.activeModelProfileId||'legacy';
  const [chosen,setChosen]=useState(active),[adding,setAdding]=useState(!list.length),[form,setForm]=useState(empty),[secret,setSecret]=useState('');
  const [pending,setPending]=useState(''),[elapsed,setElapsed]=useState(0),[error,setError]=useState(''),[message,setMessage]=useState(''),[result,setResult]=useState<TestResult>();
  const running=useRef(false);
  const selected=list.find(p=>p.id===chosen)||list.find(p=>p.id===active)||list[0];
  const dirty=!!secret.trim()||(adding&&(form.name!==empty.name||form.modelUrl!==empty.modelUrl||form.modelId!==empty.modelId));
  useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
  useEffect(()=>{if(!pending)return;const started=Date.now();setElapsed(0);const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000);return()=>clearInterval(timer);},[pending]);
  function clearFeedback(){setError('');setMessage('');setResult(undefined);}
  async function run(label:string,action:()=>Promise<void>){
    if(running.current||disabled)return;running.current=true;clearFeedback();setPending(label);onBusyChange(true);
    try{await action();}catch(e){setError(String(e));}finally{running.current=false;setPending('');onBusyChange(false);}
  }
  function accept(tested:Tested){onSaved(tested.settings);setChosen(tested.profileId);setSecret('');setResult(tested.result);}
  async function add(){
    const tested=await api<Tested>('model_profile_add',{profile:{id:crypto.randomUUID(),...form,testedAt:null},secret});
    accept(tested);setAdding(false);setForm(empty);setMessage('测试成功，配置和密钥已保存。点击“使用此配置”后切换。');
  }
  async function test(){
    if(!selected)return;
    const tested=await api<Tested>('model_test',{profileId:selected.id,secret:secret.trim()||null});
    accept(tested);setMessage('测试成功。'+(secret.trim()?'密钥已保存。':'')+(selected.id===active?'当前配置可以连接。':'可点击“使用此配置”切换。'));
  }
  function startAdding(){clearFeedback();setForm(empty);setAdding(true);}
  const busy=disabled||!!pending;
  return <section className="settings-section model-connections" aria-busy={!!pending}>
    <h3>模型连接配置</h3><p>每份配置独立保存服务地址、模型和密钥。新增配置不会切换当前模型，测试成功后由你选择使用。</p>
    <KeyGuide service="deepseek" open={!list.length}/>
    {!!list.length&&<><div className="model-profile-picker"><label>已保存的配置<select value={selected?.id||''} disabled={busy||adding||!!secret.trim()} onChange={e=>{setChosen(e.target.value);clearFeedback();}}>{list.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===active?' · 当前使用':p.testedAt?' · 测试通过':' · 待测试'}</option>)}</select></label><Button type="button" icon={<Plus/>} disabled={busy||adding||!!secret.trim()} onClick={startAdding}>新增配置</Button></div>
      {!adding&&selected&&<><div className="model-profile-details"><span>服务地址<strong>{selected.modelUrl}</strong></span><span>模型 ID<strong>{selected.modelId}</strong></span></div><label className="model-secret">此配置的 API 密钥<input type="password" autoComplete="new-password" disabled={busy} value={secret} onChange={e=>{setSecret(e.target.value);clearFeedback();}} placeholder="留空使用此配置已保存的密钥"/><small>新密钥验证通过后才替换原密钥。密钥只保存在系统凭据管理器。</small></label><div className="button-row"><Button type="button" disabled={busy} onClick={()=>void run('正在测试连接…',test)}>{secret.trim()?'测试并保存密钥':'测试连接'}</Button><Button type="button" appearance="primary" disabled={busy||selected.id===active||!selected.testedAt||!!secret.trim()} onClick={()=>void run('正在切换模型…',async()=>{const saved=await api<Settings>('model_profile_activate',{profileId:selected.id});onSaved(saved);setMessage('已切换到“'+selected.name+'”，下一次任务生效。');})}>{selected.id===active?'当前使用':'使用此配置'}</Button></div>{!!secret.trim()&&<p>有未保存的密钥，请先测试并保存，或清空输入后选择其他配置。</p>}</>}
    </>}
    {!list.length&&!adding&&<Button type="button" icon={<Plus/>} disabled={busy} onClick={startAdding}>新增模型配置</Button>}
    {adding&&<div className="model-profile-editor"><div className="settings-budget-heading"><h3>新增独立配置</h3><Button type="button" disabled={busy} onClick={()=>{clearFeedback();setForm({...empty});}}>填入 DeepSeek 推荐配置</Button><Button type="button" disabled={busy} onClick={()=>{clearFeedback();setForm({...empty,name:'MiniMax',modelUrl:'https://api.minimax.cn/v1',modelId:'MiniMax-M2.7'});}}>填入 MiniMax 示例</Button></div><div className="form-grid"><label>配置名称<input disabled={busy} value={form.name} onChange={e=>{setForm({...form,name:e.target.value});clearFeedback();}} placeholder="例如 MiniMax 办公"/></label><label>模型 ID<input disabled={busy} value={form.modelId} onChange={e=>{setForm({...form,modelId:e.target.value});clearFeedback();}} placeholder="填写账户支持的模型名称"/></label><label>API 服务地址<input type="url" disabled={busy} value={form.modelUrl} onChange={e=>{setForm({...form,modelUrl:e.target.value});clearFeedback();}} placeholder="https://api.minimax.cn/v1"/><small>填写 OpenAI 兼容 API 地址，可含 /v1 或完整 /chat/completions；不要填写文档地址。</small></label><label>此服务的 API 密钥<input type="password" autoComplete="new-password" disabled={busy} value={secret} onChange={e=>{setSecret(e.target.value);clearFeedback();}} placeholder="不会使用当前模型的密钥"/></label></div><div className="button-row"><Button type="button" appearance="primary" disabled={busy||!form.name.trim()||!form.modelUrl.trim()||!form.modelId.trim()||!secret.trim()} onClick={()=>void run('正在测试并保存新配置…',add)}>测试并保存配置</Button><Button type="button" disabled={busy} onClick={()=>{setAdding(false);setForm(empty);setSecret('');clearFeedback();}}>放弃新增</Button></div></div>}
    {(pending||result||error||message)&&<div className="model-test-feedback">{pending&&<div className="model-test-progress" role="status"><Spinner size="tiny"/><span>{pending} 已等待 {elapsed} 秒；首次授权另有确认等待时间；授权后的连接请求最多等待 30 秒。</span></div>}{result&&<div role="status"><strong>连接成功 · {(result.elapsedMs/1000).toFixed(1)} 秒</strong><p>模型：{result.model}</p><pre aria-label="模型测试实际回复">{result.text}</pre></div>}{message&&<p role="status">{message}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}</div>}
    <p>思考参数会按 MiniMax / DeepSeek 规则适配；其他兼容服务默认使用服务自身的思考设置。测试会发送一条简短消息和工具定义，不执行任何工具。</p>
  </section>;
}
