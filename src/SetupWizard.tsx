import { useEffect, useRef, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { api, desktop } from './api';
import { Modal } from './components';
import { ModelConnections } from './ModelConnections';
import { SearchConnection } from './SearchConnection';
import { useNetwork, type ServiceStatus } from './NetworkControls';
import type { Settings } from './types';
import { rebaseSettings, searchSettingsChanged } from './settingsDraft';

function SetupSearch({settings,onSaved,onDirtyChange,onBusyChange,disabled}:{settings:Settings;onSaved:(s:Settings)=>void;onDirtyChange:(dirty:boolean)=>void;onBusyChange:(busy:boolean)=>void;disabled:boolean}){
  const [draft,setDraft]=useState(settings),[secretDirty,setSecretDirty]=useState(false),baseline=useRef(settings);
  useEffect(()=>{const before=baseline.current;baseline.current=settings;setDraft(current=>rebaseSettings(current,before,settings));},[settings]);
  const dirty=secretDirty||searchSettingsChanged(draft,settings);
  useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
  return <SearchConnection settings={settings} value={draft} onChange={changes=>setDraft(current=>({...current,...changes}))} onSaved={(saved,keys=[])=>{const before=baseline.current;baseline.current=saved;setDraft(current=>rebaseSettings(current,before,saved,keys));onSaved(saved);}} onSecretDirtyChange={setSecretDirty} onBusyChange={onBusyChange} disabled={disabled}/>;
}

const steps=['添加工作目录','配置 AI','配置联网搜索','开始使用'];
export function SetupWizard({settings,onSaved,onAddRoot}:{settings:Settings;onSaved:(s:Settings)=>void;onAddRoot:()=>Promise<void>}){
  const {status,refresh}=useNetwork();const initialized=useRef(false);
  const [open,setOpen]=useState(false),[step,setStep]=useState(0),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<number|null>(null),[services,setServices]=useState<ServiceStatus|null>(null);
  useEffect(()=>{if(!status||initialized.current)return;initialized.current=true;setStep(status.setupStep);setOpen(!status.setupDismissed);},[status]);
  useEffect(()=>{const show=()=>{setError('');setPending(null);setOpen(true);};window.addEventListener('office-open-setup',show);return()=>window.removeEventListener('office-open-setup',show);},[]);
  useEffect(()=>{if(open&&desktop)void api<ServiceStatus>('service_status').then(setServices).catch(e=>setError(String(e)));},[open,step,settings.revision]);
  async function move(next:number,discard=false){
    if(busy)return;if(dirty&&!discard){setPending(next);return;}
    setBusy(true);setError('');try{await api('setup_progress',{step:next<0?step:next,dismissed:next<0});setPending(null);setDirty(false);if(next<0)setOpen(false);else setStep(next);await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}
  }
  if(!open||!desktop)return null;
  return <Modal title="开始使用 MultiTool" wide className="setup-wizard" onClose={()=>void move(-1)}>
    <p>本地文件整理为基础，AI 与联网搜索按需配置。每一步都可以稍后继续。</p>
    <ol className="setup-steps" aria-label="配置进度">{steps.map((label,i)=><li key={label} aria-current={step===i?'step':undefined} className={step===i?'active':''}><span>{i+1}</span>{label}</li>)}</ol>
    {step===0&&<section className="settings-section"><h3>先选择常用资料目录</h3><p>文件索引只读取文件名、路径等元数据；主动预览和 OCR 时在本机读取所选内容。</p>{settings.roots.length?<ul>{settings.roots.map(root=><li key={root}>{root}</li>)}</ul>:<p className="muted">还没有添加工作目录。</p>}<Button type="button" disabled={busy} onClick={()=>{setBusy(true);setError('');void onAddRoot().catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>选择工作目录</Button></section>}
    {step===1&&<ModelConnections settings={settings} onSaved={onSaved} onDirtyChange={setDirty} onBusyChange={setBusy} disabled={busy}/>}
    {step===2&&<SetupSearch settings={settings} onSaved={onSaved} onDirtyChange={setDirty} onBusyChange={setBusy} disabled={busy}/>}
    {step===3&&<section className="settings-section"><h3>配置进度已保存</h3><ul className="setup-checklist"><li>工作目录：{settings.roots.length?`已添加 ${settings.roots.length} 个`:'尚未添加，可在文件工作区继续'}</li><li>AI 模型：{services?.modelConfigured?'已配置':'尚未配置，可在“模型参数”继续'}</li><li>{settings.searchProvider==='deepseek'?'DeepSeek':'Tavily'} 搜索：{settings.searchEnabled?'已启用':services?.searchTestedAt?'已测试，尚未启用':'尚未配置，可在“联网与评分”继续'}</li></ul><p>可以先搜索文件或使用本地 OCR。首次使用联网功能时会说明服务与数据范围；联网权限可在“隐私与联网”中管理。</p><p className="muted">设置中可随时重新打开本引导。未保存的 Key 不会被记住。</p></section>}
    {pending!==null&&<div className="setup-callout" role="alert"><p>当前有未保存的配置或 Key。继续会放弃这些输入，已保存的配置会保留。</p><div className="button-row"><Button type="button" onClick={()=>setPending(null)}>继续填写</Button><Button type="button" onClick={()=>void move(pending,true)}>放弃未保存输入并继续</Button></div></div>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <footer className="dialog-actions"><Button type="button" disabled={busy} onClick={()=>void move(-1)}>稍后继续</Button>{step>0&&<Button type="button" disabled={busy} onClick={()=>void move(step-1)}>上一步</Button>}<Button type="button" disabled={busy} appearance="primary" onClick={()=>void move(step===3?-1:step+1)}>{step===3?'进入工作台':'下一步'}</Button></footer>
  </Modal>;
}
