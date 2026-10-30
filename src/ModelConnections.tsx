import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { PencilSimple, Plus, CheckCircle, Key } from '@phosphor-icons/react';
import { api } from './api';
import { KeyGuide } from './ServiceGuide';
import type { ModelProfile, Settings } from './types';
import './modelSettings.css';

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
  const [editing,setEditing]=useState<ModelProfile>();
  const [changingSecret,setChangingSecret]=useState(false);
  const [pending,setPending]=useState(''),[elapsed,setElapsed]=useState(0),[error,setError]=useState(''),[message,setMessage]=useState(''),[result,setResult]=useState<TestResult>();
  const running=useRef(false);
  const selected=list.find(p=>p.id===chosen)||list.find(p=>p.id===active)||list[0];
  const dirty=!!editing||!!secret.trim()||(adding&&(form.name!==empty.name||form.modelUrl!==empty.modelUrl||form.modelId!==empty.modelId));
  const needsNewSecret=!editing||(()=>{try{return new URL(form.modelUrl).origin!==new URL(editing.modelUrl).origin;}catch{return true;}})();
  useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
  useEffect(()=>{if(!pending)return;const started=Date.now();setElapsed(0);const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000);return()=>clearInterval(timer);},[pending]);
  function clearFeedback(){setError('');setMessage('');setResult(undefined);}
  async function run(label:string,action:()=>Promise<void>){
    if(running.current||disabled)return;running.current=true;clearFeedback();setPending(label);onBusyChange(true);
    try{await action();}catch(e){setError(String(e));}finally{running.current=false;setPending('');onBusyChange(false);}
  }
  function accept(tested:Tested){onSaved(tested.settings);setChosen(tested.profileId);setSecret('');setChangingSecret(false);setResult(tested.result);}
  async function add(){
    const tested=await api<Tested>('model_profile_add',{profile:{id:crypto.randomUUID(),...form,testedAt:null},secret});
    accept(tested);setAdding(false);setForm(empty);setMessage('测试成功，配置和密钥已保存。点击“使用此配置”后切换。');
  }
  async function test(){
    if(!selected)return;
    const tested=await api<Tested>('model_test',{profileId:selected.id,secret:secret.trim()||null});
    accept(tested);setMessage('测试成功。'+(secret.trim()?'密钥已保存。':'')+(selected.id===active?'当前配置可以连接。':'可点击“使用此配置”切换。'));
  }
  async function update(){
    if(!editing)return;
    const tested=await api<Tested>('model_profile_update',{profile:{...editing,...form},original:editing,secret:secret.trim()||null});
    accept(tested);setEditing(undefined);setForm(empty);
    setMessage('测试成功，配置修改已保存。'+(tested.profileId===(tested.settings.activeModelProfileId||'legacy')?'当前配置已更新，下一次任务生效。':'当前模型未切换，点击“使用此配置”后切换。'));
  }
  function startAdding(){clearFeedback();setChangingSecret(false);setForm(empty);setAdding(true);}
  function startEditing(){if(!selected)return;clearFeedback();setChangingSecret(false);setEditing({...selected});setForm({name:selected.name,modelUrl:selected.modelUrl,modelId:selected.modelId});}
  const busy=disabled||!!pending;
  const guideUrl=adding||editing?form.modelUrl:selected?.modelUrl;
  const deepseek=(()=>{try{return new URL(guideUrl||'').hostname==='api.deepseek.com';}catch{return false;}})();
  return <section className="settings-section model-connections" aria-busy={!!pending}>
    <div className="model-connection-heading"><div><h3>{editing?'编辑模型连接':adding?'添加模型连接':'已保存的模型连接'}</h3><p>每份连接独立保存服务地址、模型与密钥；测试通过后可选择使用。</p></div>{!!list.length&&!adding&&!editing&&<Button type="button" icon={<Plus/>} disabled={busy||!!secret.trim()} onClick={startAdding}>新增连接</Button>}</div>
    {!!list.length&&!adding&&!editing&&selected&&<>
      <div className="model-profile-picker"><label>查看配置<select aria-label="查看模型配置" value={selected.id} disabled={busy||!!secret.trim()} onChange={e=>{setChosen(e.target.value);setChangingSecret(false);clearFeedback();}}>{list.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===active?' · 当前使用':p.testedAt?' · 已测试':' · 待测试'}</option>)}</select></label><Button type="button" icon={<PencilSimple/>} disabled={busy||!!secret.trim()} onClick={startEditing}>编辑连接</Button></div>
      <div className="model-selected-heading"><strong>{selected.name}</strong><span className={`model-connection-state ${selected.id===active?'active':''}`}>{selected.id===active?'当前使用':selected.testedAt?'已测试，尚未使用':'尚未测试'}</span></div>
      <dl className="model-profile-details"><div><dt>模型 ID</dt><dd>{selected.modelId}</dd></div><div><dt>服务地址</dt><dd>{selected.modelUrl}</dd></div></dl>
      {selected.id!==active&&<p className="model-connection-note">查看配置不会切换模型。{selected.testedAt?'点击“使用此配置”后，下一次任务生效。':'请先测试连接，再选择使用。'}</p>}
      {changingSecret&&<div className="model-credential-editor"><label className="model-secret">新的 API 密钥<input aria-label="新的 API 密钥" type="password" autoComplete="new-password" autoFocus disabled={busy} value={secret} onChange={e=>{setSecret(e.target.value);clearFeedback();}} placeholder="填写此服务的新密钥"/><small>新密钥测试通过后才替换原密钥，仅保存在系统凭据管理器。</small></label>{!!secret.trim()&&<p>密钥尚未保存，请点击“测试并保存密钥”，或取消更换。</p>}</div>}
      <div className="model-connection-actions"><div className="button-row"><Button type="button" disabled={busy||(changingSecret&&!secret.trim())} onClick={()=>void run('正在测试连接…',test)}>{changingSecret?'测试并保存密钥':'测试连接'}</Button>{selected.id!==active&&<Button type="button" appearance="primary" disabled={busy||!selected.testedAt||changingSecret} onClick={()=>void run('正在切换模型…',async()=>{const saved=await api<Settings>('model_profile_activate',{profileId:selected.id});onSaved(saved);setMessage('已切换到“'+selected.name+'”，下一次任务生效。');})}>使用此配置</Button>}</div><Button type="button" appearance="subtle" icon={<Key/>} disabled={busy} onClick={()=>{setChangingSecret(v=>!v);setSecret('');clearFeedback();}}>{changingSecret?'取消更换密钥':'更换 API 密钥'}</Button></div>
    </>}
    {!list.length&&!adding&&<Button type="button" icon={<Plus/>} disabled={busy} onClick={startAdding}>新增模型配置</Button>}
    {(adding||editing)&&<div className="model-profile-editor">
      {adding&&<div className="model-service-presets"><span>快速填入</span><Button type="button" size="small" disabled={busy} onClick={()=>{clearFeedback();setForm({...empty});}}>DeepSeek 示例</Button><Button type="button" size="small" disabled={busy} onClick={()=>{clearFeedback();setForm({...empty,name:'MiniMax',modelUrl:'https://api.minimax.cn/v1',modelId:'MiniMax-M2.7'});}}>MiniMax 示例</Button></div>}
      {editing&&<p>测试通过后保存修改，失败时保留原配置。{editing.id===active?'当前使用的配置将在下一次任务生效。':'保存不会切换当前模型。'}</p>}
      <div className="form-grid">
        <label>配置名称<input aria-label="模型配置名称" autoFocus={!!editing} disabled={busy} value={form.name} onChange={e=>{setForm({...form,name:e.target.value});clearFeedback();}} placeholder="例如 MiniMax 办公"/></label>
        <label>模型 ID<input aria-label="模型 ID" disabled={busy} value={form.modelId} onChange={e=>{setForm({...form,modelId:e.target.value});clearFeedback();}} placeholder="填写账户支持的模型名称"/></label>
        <label className="model-full-width">API 服务地址<input aria-label="API 服务地址" type="url" disabled={busy} value={form.modelUrl} onChange={e=>{setForm({...form,modelUrl:e.target.value});clearFeedback();}} placeholder="https://api.minimax.cn/v1"/><small>填写 OpenAI 兼容 API 地址，可含 /v1 或完整 /chat/completions；不要填写文档地址。</small></label>
        <label className="model-full-width">此服务的 API 密钥<input aria-label="此服务的 API 密钥" type="password" autoComplete="new-password" disabled={busy} value={secret} onChange={e=>{setSecret(e.target.value);clearFeedback();}} placeholder={needsNewSecret?'请填写此服务的 API 密钥':'留空使用此配置已保存的密钥'}/><small>{editing?(needsNewSecret?'服务来源已改变，需填写新服务的密钥。':'可留空沿用原密钥；新密钥测试通过后才替换。'):'测试通过后保存，不会自动切换当前模型。'}密钥仅保存在系统凭据管理器。</small></label>
      </div>
      <div className="button-row"><Button type="button" appearance="primary" disabled={busy||!form.name.trim()||!form.modelUrl.trim()||!form.modelId.trim()||(needsNewSecret&&!secret.trim())} onClick={()=>void run(editing?'正在测试并保存修改…':'正在测试并保存新配置…',editing?update:add)}>{editing?'测试并保存修改':'测试并保存配置'}</Button><Button type="button" disabled={busy} onClick={()=>{setAdding(false);setEditing(undefined);setForm(empty);setSecret('');clearFeedback();}}>{editing?'取消编辑':'放弃新增'}</Button></div>
    </div>}
    {(pending||result||error||message)&&<div className="model-test-feedback">{pending&&<div className="model-test-progress" role="status"><Spinner size="tiny"/><span>{pending} 已等待 {elapsed} 秒；首次授权另有确认等待时间；授权后的连接请求最多等待 30 秒。</span></div>}{message&&<p className="model-test-success" role="status"><CheckCircle aria-hidden="true"/><span>{message}</span></p>}{result&&<details className="model-test-result"><summary>查看测试详情 · {(result.elapsedMs/1000).toFixed(1)} 秒</summary><p>模型：{result.model}</p><pre aria-label="模型测试实际回复">{result.text}</pre></details>}{error&&<p className="inline-error" role="alert">{error}</p>}</div>}
    <div className="model-connection-help">{deepseek&&<KeyGuide service="deepseek"/>}<details><summary>连接测试与思考参数说明</summary><p>思考参数会按 MiniMax / DeepSeek 规则适配；其他兼容服务默认使用服务自身的思考设置。测试会发送一条简短消息和工具定义，不执行任何工具。</p></details></div>
  </section>;
}
