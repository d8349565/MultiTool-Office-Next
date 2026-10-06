import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { ArrowUp, X, Sparkle, Stop, Check, CaretDown, Plus, Trash, Copy, FolderOpen, MagnifyingGlass, ImageSquare } from '@phosphor-icons/react';
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
import { deleteImages, imageContext, maxImages, saveImage, validateImage, type AssistantImage } from './assistantImages';
import { conversationHistory, evidenceSummary, workspaceKey, finishActivities, upsertActivity, loadConversations, newConversation, resultLinks, sessionKey, sessionTotals, lastQuery, taskMessage, replyText, type Conversation, type Link } from './assistantState';

export default function Assistant({open,onClose,context,onProposal,onLocate,settings}:{open:boolean;onClose:()=>void;context:unknown;onProposal:(p:Proposal)=>void;onLocate:(path:string)=>void;settings:Settings}){
  const [store,setStore]=useState(loadConversations),[storageError,setStorageError]=useState(''),[deleteIds,setDeleteIds]=useState<string[]>([]),[clock,setClock]=useState(Date.now());
  const current=store.sessions.find(s=>s.id===store.active)||store.sessions[0];
  const [managing,setManaging]=useState(false),[sessionQuery,setSessionQuery]=useState(''),[selected,setSelected]=useState<string[]>([]);
  const [workspaceOpen,setWorkspaceOpen]=useState(false),[workspacePath,setWorkspacePath]=useState(''),[workspaceNotice,setWorkspaceNotice]=useState('');
  const sessionRows=store.sessions.filter(s=>s.title.toLocaleLowerCase().includes(sessionQuery.toLocaleLowerCase()));
  const selectable=sessionRows.filter(s=>!s.task);
  const evidence=evidenceSummary(current.messages);
  const lastAssistantWithStats=[...current.messages].reverse().find(m=>m.role==='assistant'&&m.stats);
  const totals=sessionTotals(current.messages,current.task?{stats:current.stats,activities:current.activities}:undefined);
  const activeStats=current.task?current.stats:(lastAssistantWithStats?.stats??current.stats);
  const metrics=tokenMetrics(totals?.usage);
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
  function addSession(){const session=newConversation();setStore(s=>({sessions:[session,...s.sessions],active:session.id}));}
  async function removeSessions(){
    const removing=store.sessions.filter(s=>deleteIds.includes(s.id)&&!s.task).map(s=>s.id);
    try{if(desktop)await Promise.all(removing.map(sessionId=>api('delete_assistant_session',{sessionId})));
      await deleteImages(store.sessions.filter(s=>removing.includes(s.id)).flatMap(s=>[...(s.draftImages||[]),...s.messages.flatMap(m=>m.images||[])]));
      setStore(s=>{const remaining=s.sessions.filter(x=>!removing.includes(x.id)||!!x.task);if(!remaining.length)remaining.push(newConversation());return {sessions:remaining,active:remaining.some(x=>x.id===s.active)?s.active:remaining[0].id};});
      setDeleteIds([]);setSelected([]);
    }catch(error){update(current.id,s=>({...s,error:'会话清理未完成：'+String(error)}));}
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
      <button className="assistant-session-current" aria-label="管理会话" aria-expanded={managing} aria-controls="assistant-session-manager" title={current.title} onClick={()=>{setManaging(v=>!v);setWorkspaceOpen(false);setDeleteIds([]);}}><strong>{current.title}</strong><CaretDown/></button>
      <div className="assistant-header-actions">
        <IconButton label="新建会话" onClick={addSession}><Plus/></IconButton>
        <Tooltip content="报告保存位置" relationship="description"><Button appearance="subtle" size="small" icon={<FolderOpen/>} aria-label="配置报告工作区" aria-expanded={workspaceOpen} aria-controls="assistant-workspace-panel" onClick={()=>{setWorkspaceOpen(v=>!v);setManaging(false);}}/></Tooltip>
        <IconButton label="收起助手" onClick={onClose}><X/></IconButton>
      </div>
    </header>
    {managing&&<section id="assistant-session-manager" className="assistant-session-manager" aria-label="会话管理">
      <div className="assistant-session-heading"><strong>会话 · {store.sessions.length}</strong><Button size="small" appearance="subtle" icon={<Trash/>} aria-label="删除当前会话" disabled={!!current.task} onClick={()=>setDeleteIds([current.id])}>删除当前会话</Button></div>
      <div className="assistant-session-search"><MagnifyingGlass/><input aria-label="搜索会话" placeholder="搜索会话名称" value={sessionQuery} onChange={e=>setSessionQuery(e.target.value)}/></div>
      <div className="assistant-session-actions"><label><input type="checkbox" aria-label="全选可删除会话" checked={!!selectable.length&&selectable.every(s=>selected.includes(s.id))} disabled={!selectable.length} onChange={e=>setSelected(e.target.checked?selectable.map(s=>s.id):[])}/>全选</label><span>已选 {selected.length} 项</span><Button size="small" disabled={!selected.length} onClick={()=>setDeleteIds(selected)}>删除所选</Button></div>
      <div className="assistant-session-list">{sessionRows.map(s=><div className={`assistant-session-row ${s.id===current.id?'active':''}`} key={s.id}>
        <input type="checkbox" aria-label={`选择会话：${s.title}`} disabled={!!s.task} checked={selected.includes(s.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,s.id]:old.filter(id=>id!==s.id))}/>
        <button aria-current={s.id===current.id?'true':undefined} onClick={()=>{setStore(old=>({...old,active:s.id}));setManaging(false);}}><strong>{s.title}</strong><small>{s.task?'正在处理 · 暂不可删除':`${s.messages.length} 条消息${s.draft?' · 有草稿':''}`}</small></button>
      </div>)}{!sessionRows.length&&<p className="assistant-panel-empty">没有匹配的会话</p>}</div>
      <p className="assistant-panel-hint">会话保存在本机。正在处理的会话暂不可删除。</p>
    </section>}
    {!!deleteIds.length&&<div className="assistant-delete" role="group" aria-label="确认删除会话"><p>删除 {deleteIds.length} 个会话及本地聊天记录？此操作无法撤销，已生成的报告文件会保留。</p><Button size="small" onClick={removeSessions}>确认删除会话</Button><Button size="small" onClick={()=>setDeleteIds([])}>取消</Button></div>}
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
      {m.status==='waiting_input'&&m.taskContext?.intent.pendingField==='scope'&&!current.task&&i===current.messages.length-1&&<div className="assistant-scope-answers"><Button size="small" onClick={()=>void send('当前浏览目录',false,{type:'scope_answer',scope:'current'})}>当前浏览目录</Button><Button size="small" onClick={()=>void send('工作目录',false,{type:'scope_answer',scope:'workspace'})}>工作目录</Button></div>}
      {m.role==='assistant'&&<AssistantResults trace={m.trace} links={m.links||[]} onLink={l=>void openLink(l)} onCopy={p=>void act(()=>copy(p))} onFolderOpen={p=>void act(()=>api('open_path',{path:p,reveal:false}))} onMore={!current.task&&i===current.messages.length-1?()=>{const record=[...(m.trace||[])].reverse().find(r=>(r.result as any)?.hasMore);const result=record?.result as any;void send('查看下一页',false,result?.resultSetId?{type:'next_page',resultSetId:result.resultSetId,offset:result.nextOffset??((result.request?.offset||0)+(result.request?.limit||10))}:undefined);}:undefined}/>}
      {m.fault&&<div className="assistant-task-fault" role="status"><strong>{m.status==='cancelled'?'已取消':m.status==='partial'?'部分完成':m.status==='interrupted'?'上次任务中断':'任务未完成'}</strong><p>{m.fault.message}</p><small>{m.fault.recovery}</small><div><Button size="small" disabled={!!current.task} onClick={()=>retryMessage(i)}>重试本次任务</Button>{!!m.trace?.length&&<Button size="small" disabled={!!current.task} onClick={()=>void send('仅根据本会话已收集的资料整理汇报，不进行搜索或其他工具操作。',true)}>仅整理已有结果</Button>}</div></div>}{m.trace?.length&&!m.activities?.some(a=>a.kind==='tool')?<details><summary><Check/> {m.trace.length} 项工具记录 <CaretDown/></summary>{m.trace.map((t,j)=><div className="trace" key={j}><strong>{j+1} · {t.tool}</strong><pre>{JSON.stringify(t.result,null,2)}</pre></div>)}</details>:null}{m.proposals?.map(p=><Button key={p.id} onClick={()=>onProposal(p)}>查看配置变更</Button>)}</div>)}
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
<div className="assistant-metrics" aria-label="本次会话累计统计">
      <span className="assistant-metrics-progress" title={current.task ? "模型正在执行任务" : `本会话累计 ${metrics.rounds??0} 轮模型尝试，完成 ${totals?.steps??0} 步工具操作。一轮=针对你的要求做的一次完整尝试，未达成会换方向再来一轮；一步=一次工具操作。`}>
        {metrics.rounds??0} 轮 <i>·</i> {(totals?.steps??0)>0 ? `${totals?.steps} 步操作` : '直接回答'}
      </span>
      <span title={metrics.read===null?'读取（输入）用量尚未返回':'本会话累计向大模型发送的读取/输入标记（含历史与上下文）：'+metrics.read.toLocaleString()+' 个标记'} aria-label={'会话累计输入标记数：'+(metrics.read??'未知')}><abbr title="本会话累计输入/读取标记数量（Prompt Tokens）">输入</abbr> <b>{compactTokens(metrics.read)}</b></span>
      <span title={metrics.cacheRate===null?'模型服务商未返回缓存数据或该模型不支持上下文缓存':'本会话模型服务端缓存命中率（复用已有上下文省去的读取比例）：'+percent(metrics.cacheRate)} aria-label={'会话累计缓存读取率：'+percent(metrics.cacheRate)}><abbr title="本会话累计缓存读取率（Cache Hit Rate）">缓存</abbr> <b>{percent(metrics.cacheRate)}</b></span>
      <span title={metrics.written===null?'输出（生成）用量尚未返回':'本会话大模型累计输出标记（含思考过程与工具参数）：'+metrics.written.toLocaleString()+' 个标记'} aria-label={'会话累计输出标记数：'+(metrics.written??'未知')}><abbr title="本会话累计输出/生成标记数量（Completion Tokens）">输出</abbr> <b>{compactTokens(metrics.written)}</b></span>
      <span title={metrics.speed===null?'最近一次回复没有可用的生成时长，无法计算速率':'最近一次回复的生成速率（该次输出标记数 ÷ 该次生成时长）。含思考与回复，不含网络连接等待和工具执行时间。'} aria-label={'最近一次回复速率：'+(metrics.speed===null?'未知':metrics.speed.toFixed(1))}><abbr title="最近一次回复的生成速率">本次</abbr> <b>{metrics.speed===null?'—':metrics.speed.toFixed(1)}</b> <abbr title="每秒输出标记数量（Tokens per second）">t/s</abbr></span>
      <span className="assistant-metrics-speed" title={metrics.avgSpeed===null?'本会话没有可用的生成时长，无法计算平均速率':'本会话整体平均速率（全部可测请求的输出标记数 ÷ 全部生成时长之和）。低于本次速率说明本次回复较慢。'} aria-label={'本会话平均速率：'+(metrics.avgSpeed===null?'未知':metrics.avgSpeed.toFixed(1))}><abbr title="本会话整体平均生成速率">平均</abbr> <b>{metrics.avgSpeed===null?'—':metrics.avgSpeed.toFixed(1)}</b> <abbr title="每秒输出标记数量（Tokens per second）">t/s</abbr></span>
      <span className={'assistant-metrics-context'+(contextPercent!==null&&contextPercent>=80?' near-limit':'')} title={contextLimit>0?'本会话中最大的一次请求占用（输入+输出）：'+(metrics.contextTokens?.toLocaleString()??'—')+' / '+contextLimit.toLocaleString()+' 个标记；后续请求可能变化。':'请在模型参数中填写模型上下文容量。'} aria-label={'上下文占用：'+percent(contextPercent)}><span className="context-gauge" aria-hidden="true" style={{'--context-turn':(contextPercent===null?0:Math.min(100,contextPercent))+'%'} as CSSProperties}/><b>{percent(contextPercent)}</b></span>
    </div>
  </aside>;
}
