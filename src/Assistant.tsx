import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { ArrowUp, ArrowRight, X, Sparkle, Stop, Check, CaretDown, Plus, Trash, Copy, FolderOpen, MagnifyingGlass, ImageSquare, ChatsCircle, SlidersHorizontal, Coins, WarningCircle, ArrowsClockwise, Wrench, ChatCircle, ArrowLineDown, ArrowLineUp, Database, Lightning, Gauge, ListChecks } from '@phosphor-icons/react';
import { listen } from '@tauri-apps/api/event';
import { api, desktop, pick, copy } from './api';
import { runAssistantTask, resumeAssistantTask } from './assistantRuntime';
import type { Activity, AIResult, Proposal, Settings, TaskAction, TaskContext } from './types';
import { IconButton } from './components';
import { compactTokens, contextCapacity, percent, tokenMetrics } from './assistantMetrics';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AssistantResults } from './AssistantResults';
import { AssistantDelivery } from './AssistantDelivery';
import { AssistantActivity, SearchSources } from './AssistantActivity';
import { AssistantImages } from './AssistantImageAttachments';
import { AssistantCost } from './AssistantCost';
import { costMetrics, hasPricingChange, money, proposalMatchesSettings } from './assistantPricing';
import { deleteImages, imageContext, maxImages, saveImage, validateImage, type AssistantImage } from './assistantImages';
import { conversationHistory, evidenceSummary, workspaceKey, finishActivities, upsertActivity, loadConversations, newConversation, resultLinks, sessionKey, sessionTotals, lastQuery, taskMessage, replyText, type Conversation, type Link } from './assistantState';

function Metric({label,children,className=''}:{label:string;children:ReactNode;className?:string}){return <Tooltip content={label} relationship="description"><span className={className} tabIndex={0} aria-label={label}>{children}</span></Tooltip>;}

export default function Assistant({open,onClose,context,onProposal,onLocate,onPricingSettings,settings}:{open:boolean;onClose:()=>void;context:unknown;onProposal:(p:Proposal)=>void;onLocate:(path:string)=>void;onPricingSettings:()=>void;settings:Settings}){
  const [store,setStore]=useState(loadConversations),[storageError,setStorageError]=useState(''),[deleteIds,setDeleteIds]=useState<string[]>([]),[clock,setClock]=useState(Date.now());
  const current=store.sessions.find(s=>s.id===store.active)||store.sessions[0];
  const [managing,setManaging]=useState(false),[sessionQuery,setSessionQuery]=useState(''),[selected,setSelected]=useState<string[]>([]);
  const [batchMode,setBatchMode]=useState(false),[deleting,setDeleting]=useState(false),[deleteError,setDeleteError]=useState(''),[costOpen,setCostOpen]=useState(false);
  const sessionSearch=useRef<HTMLInputElement>(null),sessionTrigger=useRef<HTMLButtonElement>(null);
  const [workspaceOpen,setWorkspaceOpen]=useState(false),[workspacePath,setWorkspacePath]=useState(''),[workspaceNotice,setWorkspaceNotice]=useState('');
  const sessionRows=store.sessions.filter(s=>s.title.toLocaleLowerCase().includes(sessionQuery.toLocaleLowerCase()));
  const selectable=sessionRows.filter(s=>!s.task);
  const evidence=evidenceSummary(current.messages);
  const lastAssistantWithStats=[...current.messages].reverse().find(m=>m.role==='assistant'&&m.stats);
  const totals=sessionTotals(current.messages,current.task?{stats:current.stats,activities:current.activities}:undefined);
  const activeStats=current.task?current.stats:(lastAssistantWithStats?.stats??current.stats);
  const metrics=tokenMetrics(totals?.usage);
  const costs=costMetrics(totals?.usage);
  const contextLimit=activeStats?.contextLimit||contextCapacity(settings.modelContextTokens,settings.modelId);
  const contextPercent=metrics.contextTokens!==null&&contextLimit>0?metrics.contextTokens/contextLimit*100:null;
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const toggleActivity=(key:string,open:boolean)=>{follow.current=false;setExpanded(old=>({...old,[key]:open}));};
  const follow=useRef(true);
  const end=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),activeTasks=useRef(new Map<string,string>());
  const imageInput=useRef<HTMLInputElement>(null),imageLoading=useRef('');
  const [loadingImages,setLoadingImages]=useState('');
  const [dimensions,setDimensions]=useState(()=>{try{const d=JSON.parse(localStorage.getItem('office-assistant-size')||'null');if(Number.isFinite(d?.width)&&Number.isFinite(d?.height))return {width:Math.max(360,d.width),height:Math.max(360,d.height)};}catch{}return {width:520,height:650};});
  const drag=useRef<{x:number;y:number;width:number;height:number}|null>(null);
  function update(id:string,change:(s:Conversation)=>Conversation){setStore(old=>({...old,sessions:old.sessions.map(s=>s.id===id?change(s):s)}));}
  function changeSize(width:number,height:number){const next={width:Math.max(320,Math.min(window.innerWidth-28,width)),height:Math.max(320,Math.min(window.innerHeight-70,height))};setDimensions(next);try{localStorage.setItem('office-assistant-size',JSON.stringify(next));}catch{setStorageError('窗口尺寸保存失败。');}}
  const running=store.sessions.some(s=>s.task);
  const saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const latestStore=useRef(store);
  latestStore.current=store;
  useEffect(()=>{
    if(running){
      if(!saveTimer.current){
        saveTimer.current=setTimeout(()=>{
          saveTimer.current=null;
          try{localStorage.setItem(sessionKey,JSON.stringify(latestStore.current));setStorageError('');}catch{setStorageError('会话历史保存失败。');}
        },6000);
      }
      return;
    }
    if(saveTimer.current){clearTimeout(saveTimer.current);saveTimer.current=null;}
    try{localStorage.setItem(sessionKey,JSON.stringify(latestStore.current));setStorageError('');}catch{setStorageError('会话历史无法保存，本次仍可使用；请清理旧会话或检查磁盘空间。');}
  },[store,running]);
  useEffect(()=>{if(open)textarea.current?.focus();setDeleteIds([]);},[open,store.active]);
  useEffect(()=>{if(!managing)return;sessionSearch.current?.focus();function outside(event:PointerEvent){const target=event.target as Element;if(!target.closest?.('#assistant-session-manager')&&!target.closest?.('.assistant-session-current')&&!deleting){setManaging(false);setDeleteIds([]);}}document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[managing,deleting]);
  useEffect(()=>{if(open&&follow.current)end.current?.scrollIntoView({block:'nearest'});},[open,store.active,current.messages,current.progress,current.error,current.streaming,current.activities]);
    useEffect(()=>{if(!desktop||!open||current.task)return;let alive=true;const session=current.id;
    void api<TaskContext>('assistant_context',{sessionId:session}).then(taskContext=>{if(alive&&taskContext?.schemaVersion===1)update(session,s=>({...s,taskContext}));}).catch(()=>{});
    return()=>{alive=false;};
  },[open,current.id,current.task]);
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[running]);
  useEffect(()=>{if(!desktop)return;const unlisten=listen<{id:string;message:string}>('task-progress',e=>{setStore(old=>({...old,sessions:old.sessions.map(s=>s.task===e.payload.id?{...s,progress:e.payload.message}:s)}));});return()=>{void unlisten.then(f=>f()).catch(()=>{});};},[]);
  useEffect(()=>{if(!desktop)return;let alive=true;const timers:ReturnType<typeof setTimeout>[]=[];
    for(const session of store.sessions.filter(s=>s.recoverTask)){
      const id=session.recoverTask!;activeTasks.current.set(session.id,id);
      const recover=async()=>{try{const result=await api<AIResult&{progress?:string}>('task_status',{id});if(!alive)return;await resumeAssistantTask(result);
        if(result.status==='running'){update(session.id,s=>({...s,task:id,streaming:result.text,activities:result.activities,progress:result.progress||'正在恢复任务状态',messages:s.messages.filter(m=>m.activityKey!==id)}));timers.push(setTimeout(()=>void recover(),2000));}
        else{
          activeTasks.current.delete(session.id);
          const recoveredSteps=(result.activities||[]).filter(a=>a.kind==='tool').length;
          const recoveredRound=(Array.isArray(result.usage)&&result.usage.length)?result.usage.length:1;
          const recoveredStats={round:recoveredRound,steps:recoveredSteps,usage:result.usage,contextLimit:contextCapacity(settings.modelContextTokens,settings.modelId)};
          update(session.id,s=>({...s,task:'',recoverTask:undefined,error:'',taskContext:result.taskContext??s.taskContext,stats:recoveredStats,messages:[...s.messages.filter(m=>m.activityKey!==id),taskMessage(result,id,recoveredStats)]}));
        }
      }catch{if(alive){activeTasks.current.delete(session.id);update(session.id,s=>({...s,task:'',recoverTask:undefined,error:'无法恢复上次任务状态，旧版本可能没有保存记录。'}));}}};void recover();
    }
    return()=>{alive=false;timers.forEach(clearTimeout);};
  },[]);
  useEffect(()=>{if(!open)return;let alive=true;setWorkspacePath('');
    void api<{path:string}>('assistant_workspace',{path:current.workspace||null}).then(r=>{if(alive)setWorkspacePath(r.path);}).catch(e=>{if(alive)setWorkspaceNotice(String(e));});
    return()=>{alive=false;};
  },[open,current.workspace]);
  async function addImages(files:File[]){
    const session=current;if(!files.length||imageLoading.current||activeTasks.current.has(session.id))return;
    const saved:AssistantImage[]=[];
    imageLoading.current=session.id;setLoadingImages(session.id);
    try{
      if((session.draftImages?.length||0)+files.length>maxImages)throw new Error('每次最多添加 4 张图片。');
      files.forEach(validateImage);
      for(const file of files)saved.push(await saveImage(file));
      if(!latestStore.current.sessions.some(s=>s.id===session.id)){await deleteImages(saved);return;}
      update(session.id,s=>({...s,draftImages:[...(s.draftImages||[]),...saved],error:''}));
    }catch(e){await deleteImages(saved).catch(()=>{});update(session.id,s=>({...s,error:String(e)}));}
    finally{imageLoading.current='';setLoadingImages('');}
  }
  async function removeImage(image:AssistantImage){
    const session=current;if(activeTasks.current.has(session.id)||imageLoading.current===session.id)return;
    try{await deleteImages([image]);update(session.id,s=>({...s,draftImages:(s.draftImages||[]).filter(v=>v.id!==image.id)}));}
    catch(e){update(session.id,s=>({...s,error:String(e)}));}
  }
  async function send(text=current.draft,respondOnly=false,action?:TaskAction,images:AssistantImage[]=!respondOnly&&!action&&text===current.draft?(current.draftImages||[]):[]){
    const session=current;if((!text.trim()&&!images.length)||activeTasks.current.has(session.id)||imageLoading.current===session.id)return;
    if(!text.trim())text='请描述并分析这些图片。';
    let submitted=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let stopStream:(()=>void)|undefined;
    let stopActivity:(()=>void)|undefined;
    let stopUsage:(()=>void)|undefined;
    let stopContext:(()=>void)|undefined;
    try{
      const id=crypto.randomUUID();follow.current=true;activeTasks.current.set(session.id,id);setClock(Date.now());
      if(desktop)stopStream=await listen<{id:string;text:string}>('task-stream',e=>{if(e.payload.id===id)update(session.id,s=>s.task===id?{...s,streaming:e.payload.text}:s);});
      if(desktop)stopActivity=await listen<{id:string;activity:Activity}>('task-activity',e=>{if(e.payload.id===id)update(session.id,s=>s.task===id?{...s,activities:upsertActivity(s.activities,e.payload.activity),stats:s.stats?{...s.stats,steps:upsertActivity(s.activities,e.payload.activity).filter(a=>a.kind==='tool').length}:s.stats}:s);});
      if(desktop)stopUsage=await listen<{id:string;round:number;usage:unknown}>('task-usage',e=>{if(e.payload.id===id)update(session.id,s=>s.task===id&&s.stats?{...s,stats:{...s.stats,round:e.payload.round,usage:e.payload.usage}}:s);});
      if(desktop)stopContext=await listen<{id:string;taskContext:TaskContext}>('task-context',e=>{if(e.payload.id===id)update(session.id,s=>s.task===id?{...s,taskContext:e.payload.taskContext}:s);});
      const history=conversationHistory(session.messages,settings.assistantHistoryMessages??12,settings.assistantHistoryChars??4000);
      const attachments=await imageContext(history,images);
      submitted=true;
      update(session.id,s=>({...s,title:s.messages.length?s.title:text.trim().slice(0,30),draft:'',draftImages:(s.draftImages||[]).filter(v=>!images.some(image=>image.id===v.id)),lastPrompt:text,task:id,started:Date.now(),stats:{round:0,steps:0,usage:[],contextLimit:contextCapacity(settings.modelContextTokens,settings.modelId)},error:'',streaming:'',activities:[],progress:'正在连接模型',messages:[...s.messages,{role:'user',text,images}]}));
      const timeoutSecs=settings.assistantTaskTimeoutSecs??600;
      const timeout=new Promise<AIResult>((resolve,reject)=>{timer=setTimeout(()=>{void api<AIResult>('task_status',{id}).then(async result=>{if(result.status==='running'){
        update(session.id,s=>({...s,progress:'正在核对后端任务状态'}));
        const deadline=result.deadlineAt??Date.now()+6000;
        while(result.status==='running'&&Date.now()<deadline+15000){await new Promise(r=>setTimeout(r,2000));result=await api<AIResult>('task_status',{id});}
        if(result.status==='running')throw new Error('前后端状态暂时失联，尚不能确认任务已停止。已保留任务编号，请重新打开助手核对状态。');
      }resolve(result);}).catch(reject);},(timeoutSecs+15)*1000);});
      const result=await Promise.race([runAssistantTask({id,kind:'agent',text,context:{sessionId:session.id,taskContextVersion:session.taskContext?.version,action,view:context,...attachments,lastQuery:lastQuery(session.messages),previousTask:[...session.messages].reverse().find(m=>m.role==='assistant')?.activityKey,reportWorkspace:session.workspace,evidence:evidenceSummary(session.messages),respondOnly,localTime:new Date().toString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}}),timeout]);
      if(!result.text?.trim())throw new Error('模型返回空回复，请检查模型是否支持工具调用。');
      const liveSession=()=>latestStore.current.sessions.find(s=>s.id===session.id);
      const finalRound=liveSession()?.stats?.round||((Array.isArray(result.usage)&&result.usage.length)?result.usage.length:1);
      const finalSteps=[...(result.activities??liveSession()?.activities??[])].filter(a=>a.kind==='tool').length;
      // 收尾必须取本次任务的真实用量；发起任务时的旧快照只是兜底，绝不能覆盖新数据。
      const resultUsage=Array.isArray(result.usage)?result.usage:undefined;
      const inFlight=liveSession()?.stats;
      const liveUsage=Array.isArray(inFlight?.usage)?inFlight.usage:undefined;
      const finalUsage=(resultUsage?.length??0)>=(liveUsage?.length??0)?(resultUsage??liveUsage):liveUsage;
      const finishedStats={round:finalRound,steps:finalSteps,usage:finalUsage,contextLimit:contextCapacity(settings.modelContextTokens,settings.modelId)};
      update(session.id,s=>({...s,error:'',taskContext:result.taskContext??s.taskContext,stats:finishedStats,messages:[...s.messages,taskMessage({...result,activities:result.activities||s.activities,fault:result.fault||(result.warning?{code:'partial',message:result.warning,recovery:'可仅整理已有结果'}:undefined)},s.task,finishedStats)]}));
    }catch(e){
      if(!submitted){update(session.id,s=>({...s,error:String(e)}));return;}
      const failedStats=latestStore.current.sessions.find(s=>s.id===session.id)?.stats??session.stats;
      update(session.id,s=>({...s,error:'',messages:[...s.messages,taskMessage({status:'failed',text:s.streaming||'本次任务未完成。',fault:{code:'frontend_error',message:String(e),recovery:'核对任务状态后重试'},activities:s.activities,trace:s.activities?.filter(a=>a.kind==='tool'&&a.result!==undefined).map(a=>({tool:a.tool||'',result:a.result}))},s.task,failedStats)]}));
    }finally{clearTimeout(timer);stopStream?.();stopActivity?.();stopUsage?.();stopContext?.();activeTasks.current.delete(session.id);update(session.id,s=>({...s,task:'',progress:'',streaming:'',activities:[]}));}
  }
  async function act(fn:()=>Promise<unknown>){const id=current.id;try{await fn();}catch(e){update(id,s=>({...s,error:String(e)}));}}
  function retryMessage(index=current.messages.length){const message=current.messages.slice(0,index).reverse().find(m=>m.role==='user');void send(message?.text||current.lastPrompt,false,undefined,message?.images||[]);}
  async function openLink(link:Link){await act(async()=>{if(link.kind==='web'){if(desktop)await api('open_web_url',{url:link.target});else window.open(link.target,'_blank','noopener,noreferrer');}else if(link.kind==='report')await api('open_report',{id:link.target});else if(link.kind==='file'){const result=await api<{groups:{status:string;error?:string}[]}>('reveal_paths',{paths:[link.target]});const failed=result.groups?.filter(g=>g.status==='failed');if(failed?.length)throw new Error(failed.map(g=>g.error||'定位失败').join('\n'));}else onLocate(link.target);});}
  function addSession(){const session=newConversation();setStore(s=>({sessions:[session,...s.sessions],active:session.id}));setManaging(false);setBatchMode(false);setSelected([]);setDeleteIds([]);}
  async function removeSessions(){
    if(deleting)return;setDeleting(true);setDeleteError('');
    const removing=store.sessions.filter(s=>deleteIds.includes(s.id)&&!s.task).map(s=>s.id);
    try{if(desktop)await Promise.all(removing.map(sessionId=>api('delete_assistant_session',{sessionId})));
      await deleteImages(store.sessions.filter(s=>removing.includes(s.id)).flatMap(s=>[...(s.draftImages||[]),...s.messages.flatMap(m=>m.images||[])]));
      setStore(s=>{const remaining=s.sessions.filter(x=>!removing.includes(x.id)||!!x.task);if(!remaining.length)remaining.push(newConversation());return {sessions:remaining,active:remaining.some(x=>x.id===s.active)?s.active:remaining[0].id};});
      setDeleteIds([]);setSelected([]);
    }catch(error){setDeleteError('会话清理未完成：'+String(error));}finally{setDeleting(false);}
  }
  async function chooseWorkspace(){await act(async()=>{
    const path=await pick(true);if(!path)return;
    const folder=await api<{path:string}>('assistant_workspace',{path});
    update(current.id,s=>({...s,workspace:path}));setWorkspacePath(folder.path);setWorkspaceNotice('已更改本会话的报告保存位置。');
  });}
  function useDefaultWorkspace(path:string){try{localStorage.setItem(workspaceKey,path);setWorkspaceNotice('已保存，新建会话会使用此目录。');}catch{setWorkspaceNotice('默认目录保存失败，请检查本地存储空间。');}}
  const elapsed=Math.max(0,Math.floor((clock-current.started)/1000));
  const runningReasoningChars=current.activities?.find(a=>a.kind==='reasoning'&&a.status==='running')?.text?.length||0;
  return <aside className={`assistant ${open?'open':''}`} style={{'--assistant-width':`${dimensions.width}px`,'--assistant-height':`${dimensions.height}px`} as CSSProperties} aria-label="工作台助手" aria-hidden={!open} inert={!open}>
    <div className="assistant-resize" role="separator" aria-label="调整助手窗口大小" title="拖动或使用方向键调整大小" tabIndex={0}
      onPointerDown={e=>{const box=e.currentTarget.parentElement!.getBoundingClientRect();drag.current={x:e.clientX,y:e.clientY,width:box.width,height:box.height};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{const d=drag.current;if(d)changeSize(d.width+d.x-e.clientX,d.height+d.y-e.clientY);}}
      onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}
      onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();changeSize(dimensions.width+(e.key==='ArrowLeft'?20:e.key==='ArrowRight'?-20:0),dimensions.height+(e.key==='ArrowUp'?20:e.key==='ArrowDown'?-20:0));}}/>
    <header className="assistant-header">
      <div className="assistant-heading"><div className="assistant-symbol" aria-hidden="true"><Sparkle weight="fill"/></div><h2>工作台助手</h2></div>
      <button ref={sessionTrigger} className="assistant-session-current" aria-label="切换会话" aria-expanded={managing} aria-controls="assistant-session-manager" title={current.title} disabled={deleting} onClick={()=>{setManaging(v=>!v);setWorkspaceOpen(false);setDeleteIds([]);setDeleteError('');}}><strong>{current.title}</strong><CaretDown/></button>
      <div className="assistant-header-actions">
        <IconButton label="新建会话" disabled={deleting} onClick={addSession}><Plus/></IconButton>
        <Tooltip content="报告保存位置" relationship="description"><Button appearance="subtle" size="small" icon={<FolderOpen/>} aria-label="配置报告工作区" aria-expanded={workspaceOpen} aria-controls="assistant-workspace-panel" onClick={()=>{setWorkspaceOpen(v=>!v);setManaging(false);}}/></Tooltip>
        <IconButton label="收起助手" onClick={onClose}><X/></IconButton>
      </div>
    </header>
    {managing&&<section id="assistant-session-manager" className="assistant-session-manager" aria-label="会话管理" onKeyDown={e=>{if(e.key==='Escape'&&!deleting){e.preventDefault();setManaging(false);setDeleteIds([]);sessionTrigger.current?.focus();}}}>
      <div className="assistant-session-heading"><div><strong>切换会话</strong><small>{store.sessions.length}</small></div><IconButton label={batchMode?'完成管理':'批量管理会话'} disabled={deleting} onClick={()=>{setBatchMode(v=>!v);setSelected([]);setDeleteIds([]);}}>{batchMode?<Check size={18}/>:<ListChecks size={18}/>}</IconButton></div>
      <div className="assistant-session-search"><MagnifyingGlass size={18}/><input ref={sessionSearch} aria-label="搜索会话" placeholder="搜索会话…" value={sessionQuery} onChange={e=>setSessionQuery(e.target.value)}/>{sessionQuery&&<IconButton label="清除会话搜索" onClick={()=>setSessionQuery('')}><X/></IconButton>}</div>
      {batchMode&&<div className="assistant-session-actions"><label><input type="checkbox" aria-label="全选匹配的可删除会话" checked={!!selectable.length&&selectable.every(s=>selected.includes(s.id))} disabled={!selectable.length||deleting} onChange={e=>setSelected(e.target.checked?selectable.map(s=>s.id):[])}/>全选匹配</label><span>已选 {selected.length} 项</span><Button size="small" appearance="subtle" icon={<Trash/>} disabled={!selected.length||deleting} onClick={()=>setDeleteIds(selected)}>删除</Button></div>}
      <div className="assistant-session-list">{sessionRows.map(s=><div className={`assistant-session-row ${s.id===current.id?'active':''}`} key={s.id}>
        {batchMode?<input type="checkbox" aria-label={`选择会话：${s.title}`} disabled={!!s.task||deleting} checked={selected.includes(s.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,s.id]:old.filter(id=>id!==s.id))}/>:<ChatsCircle className="assistant-session-icon" size={20} weight={s.id===current.id?'duotone':'regular'}/>}
        <button className="assistant-session-switch" disabled={deleting} aria-current={s.id===current.id?'true':undefined} onClick={()=>{setStore(old=>({...old,active:s.id}));setManaging(false);}}><strong>{s.title}</strong><span className="assistant-session-preview">{s.task?'正在处理…':s.messages.at(-1)?.text.replace(/\s+/g,' ').slice(0,90)||'开始一段新的对话'}</span><small>{s.messages.length} 条消息{s.draft?' · 有草稿':''}{s.id===current.id?' · 当前会话':''}</small></button>
        {!batchMode&&<IconButton label={`删除会话：${s.title}`} disabled={!!s.task||deleting} onClick={()=>{setDeleteError('');setDeleteIds([s.id]);}}><Trash size={16}/></IconButton>}
      </div>)}{!sessionRows.length&&<div className="assistant-panel-empty"><MagnifyingGlass size={24}/><strong>没有找到会话</strong><span>换个关键词试试</span></div>}</div>
      {deleteIds.length?<div className="assistant-delete" role="group" aria-label="确认删除会话"><strong>删除 {deleteIds.length} 个会话？</strong><p>聊天记录将被删除，已生成的报告保留。此操作无法撤销。</p>{deleteError&&<p className="inline-error" role="alert">{deleteError}</p>}<div><Button size="small" disabled={deleting} onClick={()=>setDeleteIds([])}>保留会话</Button><Button size="small" className="assistant-danger-action" disabled={deleting} onClick={()=>void removeSessions()}>{deleting?'正在删除…':'确认删除'}</Button></div></div>:<footer className="assistant-session-footer"><span>会话保存在本机</span><IconButton label="新建会话" onClick={addSession}><Plus size={18}/></IconButton></footer>}
    </section>}
    {workspaceOpen&&<section id="assistant-workspace-panel" className="assistant-workspace-panel" aria-label="报告工作区配置">
      <div className="assistant-workspace-heading"><strong>报告保存位置</strong><small>{current.workspace?'自选目录':'默认目录'}</small></div>
      <p>助手生成的文件核对报告保存在这里。</p><div className="assistant-workspace-path">{workspacePath||current.workspace||'正在获取默认目录…'}</div>
      <div className="assistant-panel-actions"><Button size="small" disabled={!!current.task} onClick={()=>void chooseWorkspace()}>选择文件夹</Button><Button size="small" onClick={()=>void act(()=>api('assistant_workspace',{path:current.workspace||null,open:true}))}>打开目录</Button><Button size="small" disabled={!!current.task} onClick={()=>{update(current.id,s=>({...s,workspace:''}));setWorkspaceNotice('本会话已恢复应用默认目录。');}}>恢复默认</Button></div>
      <Button size="small" disabled={!!current.task} onClick={()=>useDefaultWorkspace(current.workspace)}>新会话也用此目录</Button>
      <p className="assistant-panel-hint">此处设置保存位置，不会自动读取文件或扩大助手的操作权限。更改目录不会移动已有报告。</p>{workspaceNotice&&<p role="status" className="assistant-panel-hint">{workspaceNotice}</p>}
    </section>}
    {!current.task&&!!evidence&&<div className="assistant-evidence-action"><Button size="small" onClick={()=>void send('仅根据本会话已收集的资料整理汇报，不进行搜索或其他工具操作。保留来源，明确资料不足之处。',true)}>仅整理已有资料</Button></div>}
    {storageError&&<div className="inline-error" role="alert">{storageError}</div>}
    {((settings.modelRequestTimeoutSecs??45)<300||(settings.assistantTaskTimeoutSecs??180)<600)&&<div className="assistant-budget-notice"><span>当前总等待预算较短，可能中断持续思考。</span><Button className="assistant-budget-action" appearance="subtle" size="small" aria-label="查看防中断配置建议" onClick={()=>void act(async()=>onProposal(await api<Proposal>('assistant_budget_proposal')))}>调整等待</Button></div>}
    <div className="assistant-conversation" onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}>
      {!current.messages.length?<div className="assistant-welcome"><Sparkle size={36} weight="thin"/><h3>查找、搜索与日常问题，<br/>都可以交给助手。</h3><p>新会话独立保留上下文、草稿和报告目录。<br/>本地文件只使用元数据；联网搜索需在设置中启用。</p><div className="suggestions">{['帮我搜索今天的科技新闻并附上来源','帮我查找名称包含“进度表”的文件','检查当前目录下缺少配套 PDF 交付件的文件夹'].map(s=><button key={s} onClick={()=>void send(s)}>{s}<ArrowUp/></button>)}</div></div>:current.messages.map((m,i)=><div className={`message ${m.role==='assistant'?'reply':m.role}`} key={i}><span>{m.role==='user'?'你':'Office 助手'}</span>{m.role==='assistant'&&<AssistantActivity scope={m.activityKey||current.id+':'+i} expanded={expanded} onToggle={toggleActivity} items={m.activities||[]} onLink={l=>void openLink(l)}/>}
      {m.role==='assistant'?<AssistantMarkdown text={m.text} onLink={l=>void openLink(l)}/>:<><p>{m.text}</p><AssistantImages images={m.images||[]}/></>}{m.role==='assistant'&&<IconButton label="复制回复" onClick={()=>void act(()=>copy(replyText(m)))}><Copy/></IconButton>}{<SearchSources links={m.links||[]} onLink={l=>void openLink(l)} onToggle={()=>{follow.current=false;}}/>}
      {m.role==='assistant'&&<AssistantDelivery delivery={m.delivery}/>}
      {m.status==='waiting_input'&&m.taskContext?.intent.pendingField==='scope'&&!current.task&&i===current.messages.length-1&&<div className="assistant-decision" role="group" aria-label="选择查询范围"><strong>选择查询范围</strong><p>选定范围后，助手继续完成这次任务。</p><div className="assistant-scope-answers">{[{scope:'current',label:'当前浏览目录',detail:'仅查询正在浏览的目录'},{scope:'workspace',label:'工作目录',detail:'查询已配置的工作目录'}].map(choice=><button className="assistant-choice" key={choice.scope} onClick={()=>void send(choice.label,false,{type:'scope_answer',scope:choice.scope as 'current'|'workspace'})}><FolderOpen size={20}/><span><strong>{choice.label}</strong><small>{choice.detail}</small></span><ArrowRight size={16}/></button>)}</div></div>}
      {m.role==='assistant'&&<AssistantResults trace={m.trace} links={m.links||[]} onLink={l=>void openLink(l)} onCopy={p=>void act(()=>copy(p))} onFolderOpen={p=>void act(()=>api('open_path',{path:p,reveal:false}))} onMore={!current.task&&i===current.messages.length-1?()=>{const record=[...(m.trace||[])].reverse().find(r=>(r.result as any)?.hasMore);const result=record?.result as any;void send('查看下一页',false,result?.resultSetId?{type:'next_page',resultSetId:result.resultSetId,offset:result.nextOffset??((result.request?.offset||0)+(result.request?.limit||10))}:undefined);}:undefined}/>}
      {m.fault&&<div className="assistant-task-fault" role="status"><strong>{m.status==='cancelled'?'已取消':m.status==='partial'?'部分完成':m.status==='interrupted'?'上次任务中断':'任务未完成'}</strong><p>{m.fault.message}</p><small>{m.fault.recovery}</small><div><Button size="small" disabled={!!current.task} onClick={()=>retryMessage(i)}>重试本次任务</Button>{!!m.trace?.length&&<Button size="small" disabled={!!current.task} onClick={()=>void send('仅根据本会话已收集的资料整理汇报，不进行搜索或其他工具操作。',true)}>仅整理已有结果</Button>}</div></div>}{m.trace?.length&&!m.activities?.some(a=>a.kind==='tool')?<details><summary><Check/> {m.trace.length} 项工具记录 <CaretDown/></summary>{m.trace.map((t,j)=><div className="trace" key={j}><strong>{j+1} · {t.tool}</strong><pre>{JSON.stringify(t.result,null,2)}</pre></div>)}</details>:null}{m.proposals?.map(p=><div className="assistant-proposal" key={p.id}><div className="assistant-proposal-heading"><SlidersHorizontal size={18}/><strong>{hasPricingChange(p)?'计价调整建议':'配置调整建议'}</strong><span>{proposalMatchesSettings(p,settings)?'已生效':'待你确认'}</span></div><p>{p.reason||'助手已整理调整建议，查看具体差异后决定是否应用。'}</p>{!proposalMatchesSettings(p,settings)&&<div className="assistant-proposal-actions"><Button size="small" appearance="primary" onClick={()=>onProposal(p)}>查看建议与差异</Button><Button size="small" appearance="subtle" onClick={()=>void act(async()=>{await api('decide_proposal',{id:p.id,approve:false});update(current.id,s=>({...s,messages:s.messages.map((message,index)=>index===i?{...message,proposals:message.proposals?.filter(item=>item.id!==p.id)}:message)}));})}>暂不应用</Button></div>}</div>)}</div>)}
      {current.task&&<AssistantActivity scope={current.task} expanded={expanded} onToggle={toggleActivity} items={current.activities||[]} onLink={l=>void openLink(l)}/>}
      {current.task&&current.streaming&&<div className="message reply" aria-label="正在生成的回复"><span>Office 助手</span><AssistantMarkdown text={current.streaming} onLink={l=>void openLink(l)}/></div>}
      {current.task&&<div className="task-progress" role="status"><span className="status-dot busy"/>{current.progress} · {elapsed} 秒{runningReasoningChars>0?` · 已接收 ${runningReasoningChars.toLocaleString()} 字符`:''}{elapsed>=20?'（模型仍在处理，可取消）':''}</div>}{current.error&&<div className="inline-error" role="alert">{current.error}<Button disabled={!!current.task||!current.lastPrompt} onClick={()=>retryMessage()}>重试</Button></div>}<div ref={end}/>
    </div>
    <form className="assistant-input" onSubmit={e=>{e.preventDefault();void send();}}>
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择助手图片" onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void addImages(files);}}/>
      <AssistantImages images={current.draftImages||[]} onRemove={!current.task&&loadingImages!==current.id?image=>void removeImage(image):undefined}/>
      <label className="sr-only" htmlFor="assistant-text">任务内容</label>
      <textarea ref={textarea} id="assistant-text" value={current.draft} onChange={e=>update(current.id,s=>({...s,draft:e.target.value}))} placeholder="输入问题，也可粘贴图片…" onPaste={e=>{const files=Array.from(e.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);if(files.length){e.preventDefault();void addImages(files);}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
      {!!current.draftImages?.length&&<p className="assistant-image-notice">发送后图片原始内容会交给当前模型，不会自动脱敏；需使用支持图片的模型。每次请求最多携带 4 张当前及历史图片。</p>}
      <div className="assistant-input-actions"><IconButton label="添加图片" disabled={!!current.task||loadingImages===current.id||(current.draftImages?.length||0)>=maxImages} onClick={()=>imageInput.current?.click()}><ImageSquare/></IconButton><span>{loadingImages===current.id?'正在添加图片…':'Enter 发送 · Shift+Enter 换行'}</span>{current.task?<IconButton label="取消任务" onClick={()=>void act(async()=>{update(current.id,s=>({...s,progress:'正在取消'}));await api('cancel_task',{id:current.task});})}><Stop weight="fill"/></IconButton>:<Button type="submit" appearance="primary" icon={<ArrowUp/>} aria-label="发送任务" disabled={loadingImages===current.id||(!current.draft.trim()&&!current.draftImages?.length)}/>}</div>
    </form>
    {costOpen&&<AssistantCost cost={costs} onClose={()=>setCostOpen(false)} onConfigure={onPricingSettings} reviewDisabled={!!current.task} onReview={()=>{setCostOpen(false);void send('请仅使用 pricing_read 和公开联网搜索核对当前模型的最新计价规则。先说明来源、调整原因与费用影响，再通过 pricing_propose_change 提交建议等待我确认。不要读取任何目录、文件信息，也不要修改其他配置。');}}/>}
<div className="assistant-metrics" aria-label="本次会话累计统计">
      <Tooltip content={'会话费用明细；按请求时单价和实际返回用量计算'+(costs.missing?'，有 '+costs.missing+' 次请求无法完整计费':'')} relationship="description"><button className="assistant-metrics-cost" aria-label="会话费用明细" aria-expanded={costOpen} aria-controls="assistant-cost-panel" onClick={()=>setCostOpen(v=>!v)}><Coins size={15} aria-hidden="true"/><b>{costs.totals.length?costs.totals.map(t=>money(t.total,t.currency)).join(' + '):'—'}</b>{costs.missing>0&&<WarningCircle size={14} className="assistant-cost-incomplete" aria-hidden="true"/>}<CaretDown size={12} aria-hidden="true"/></button></Tooltip>
      <Metric label={'本会话累计 '+(metrics.rounds??0)+' 轮模型尝试'}><ArrowsClockwise size={14} aria-hidden="true"/><b>{metrics.rounds??0}</b></Metric>
      <Metric label={(totals?.steps??0)>0?'本会话累计 '+totals?.steps+' 步工具操作':'直接回答，尚未执行工具操作'}>{(totals?.steps??0)>0?<><Wrench size={14} aria-hidden="true"/><b>{totals?.steps}</b></>:<ChatCircle size={14} aria-hidden="true"/>}</Metric>
      <Metric label={metrics.read===null?'输入 token 用量尚未返回':'累计输入 '+metrics.read.toLocaleString()+' token，含历史与上下文'}><ArrowLineDown size={14} aria-hidden="true"/><b>{compactTokens(metrics.read)}</b></Metric>
      <Metric label={metrics.cacheRate===null?'服务商未返回完整缓存数据':'会话缓存命中率 '+percent(metrics.cacheRate)}><Database size={14} aria-hidden="true"/><b>{percent(metrics.cacheRate)}</b></Metric>
      <Metric label={metrics.written===null?'输出 token 用量尚未返回':'累计输出 '+metrics.written.toLocaleString()+' token，含思考和工具参数'}><ArrowLineUp size={14} aria-hidden="true"/><b>{compactTokens(metrics.written)}</b></Metric>
      <Metric label={metrics.speed===null?'最近一次回复没有可用的生成时长':'最近一次回复的生成速率：'+metrics.speed.toFixed(1)+' token / 秒；含思考与回复，不含工具执行'}><Lightning size={14} aria-hidden="true"/><b>{metrics.speed===null?'—':metrics.speed.toFixed(1)}</b><span className="assistant-metric-unit">t/s</span></Metric>
      <Metric className="assistant-metrics-speed" label={metrics.avgSpeed===null?'没有可用的生成时长，无法计算会话平均速率':'会话平均生成速率：'+metrics.avgSpeed.toFixed(1)+' token / 秒；按全部可测请求的输出与生成时长汇总'}><Gauge size={14} aria-hidden="true"/><b>{metrics.avgSpeed===null?'—':metrics.avgSpeed.toFixed(1)}</b><span className="assistant-metric-unit">t/s</span></Metric>
      <Metric className={'assistant-metrics-context'+(contextPercent!==null&&contextPercent>=80?' near-limit':'')} label={contextLimit>0?'最大一次请求的上下文占用（输入 + 输出）：'+(metrics.contextTokens?.toLocaleString()??'—')+' / '+contextLimit.toLocaleString()+' token':'请在模型参数中填写上下文容量'}><span className="context-gauge" aria-hidden="true" style={{'--context-turn':(contextPercent===null?0:Math.min(100,contextPercent))+'%'} as CSSProperties}/><b>{percent(contextPercent)}</b></Metric>
    </div>
  </aside>;
}
