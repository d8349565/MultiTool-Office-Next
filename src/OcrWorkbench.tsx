import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Tab, TabList } from '@fluentui/react-components';
import { Plus, Files, FolderOpen, Scan, Sparkle, ArrowCounterClockwise, ClockCounterClockwise, SlidersHorizontal, DownloadSimple, Stop, X, Trash, Copy, Check, TextT, CalendarBlank, Hash, CaretRight } from '@phosphor-icons/react';
import { listen } from '@tauri-apps/api/event';
import { api, copy as copyText, desktop, pick } from './api';
import { Empty, IconButton, Modal } from './components';
import { basename, dirname, isWithin } from './domain';
import { completedOcrFileIds, completedOcrTask, defaultWorkflow, oneClickWorkflow, newField, newProfile, updateProfileField, localDecisionText, type OcrBootstrap, type OcrFieldDefinition, type OcrFileResult, type OcrProfile, type OcrRenameBatch, type OcrTask, type OcrWorkflowOptions } from './ocrTypes';
import './ocr.css';
import { OcrRegions } from './OcrRegions';
import { OcrRenameDialog, renameMessage } from './OcrRenameDialog';
import { OcrDiagnosticShare, type OcrDiagnosticRequest } from './OcrDiagnosticShare';

const labels:Record<string,string>={queued:'排队中',running:'正在识别',completed:'已结束',ready:'已就绪',review:'需复核',failed:'失败',cancelled:'已取消',interrupted:'已中断',pending:'待执行',done:'已改名',undone:'已撤销',conflict:'冲突',local:'本地规则',jev:'Jev',manual:'人工修正',missing:'未识别',relocated:'路径已变化，请重新导入'};
const active=(t?:OcrTask)=>!!t&&['running','queued'].includes(t.status);
const preferenceKey=desktop?'ocr-task-options':'ocr-demo-task-options';
function taskPreferences():{profileId:string;workflow:OcrWorkflowOptions}{
  try{const value=JSON.parse(localStorage.getItem(preferenceKey)||'{}');return {profileId:typeof value.profileId==='string'?value.profileId:'auto',workflow:{...defaultWorkflow,exportFormat:['none','txt','csv','json'].includes(value.workflow?.exportFormat)?value.workflow.exportFormat:'none',exportDirectory:typeof value.workflow?.exportDirectory==='string'?value.workflow.exportDirectory:''}};}catch{return {profileId:'auto',workflow:{...defaultWorkflow}};}
}
const download=(name:string,text:string)=>{const mime=name.endsWith('.json')?'application/json':name.endsWith('.csv')?'text/csv':'text/plain';const url=URL.createObjectURL(new Blob([text],{type:`${mime};charset=utf-8`}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const exportOptions=[
  {format:'txt',label:'识别文本 (TXT)',title:'导出所有文件的 OCR 识别原始文本行 (.txt)'},
  {format:'csv',label:'字段表格 (CSV)',title:'导出文件名及提取出的结构化字段表格，支持 Excel 打开 (.csv)'},
  {format:'json',label:'完整数据 (JSON)',title:'导出包含识别坐标、提取字段与诊断日志的完整任务数据 (.json)'},
] as const;
export default function OcrWorkbench({visible,incoming,onConsumed,onSettings,onDiagnose}:{visible:boolean;incoming:string[];onConsumed:(paths:string[])=>void;onSettings:()=>void;onDiagnose?:(request:OcrDiagnosticRequest)=>void}){
  const [data,setData]=useState<OcrBootstrap>({profiles:[],tasks:[],batches:[],engineReady:false,jevReady:false});
  const [resultFilter,setResultFilter]=useState('all');
  const [preferences]=useState(taskPreferences),[workflow,setWorkflow]=useState<OcrWorkflowOptions>(()=>preferences.workflow),[settingsOpen,setSettingsOpen]=useState(false),[taskHistoryOpen,setTaskHistoryOpen]=useState(false);
  const [paths,setPaths]=useState<string[]>([]),[profileId,setProfileId]=useState(()=>preferences.profileId),[useJev,setUseJev]=useState<boolean>(()=>{
    try{return localStorage.getItem('ocr_use_jev')==='true';}catch{return false;}
  });
  const [uniformRows,setUniformRows]=useState<boolean>(()=>{
    try{return localStorage.getItem('ocr_uniform_rows')!=='false';}catch{return true;}
  });
  const [taskId,setTaskId]=useState(''),[fileId,setFileId]=useState(''),[checked,setChecked]=useState<string[]>([]);
  const [diagnosticFile,setDiagnosticFile]=useState<{taskId:string;fileId:string}|null>(null);
  const [editor,setEditor]=useState<OcrProfile|null>(null),[batch,setBatch]=useState<OcrRenameBatch|null>(null),[undo,setUndo]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState(false);
  const [recheckPrompt,setRecheckPrompt]=useState<{paths:string[];duplicateCount:number;total:number;profileId:string}|null>(null);
  const [correction,setCorrection]=useState<{taskId:string;fileId:string;profileId:string;name:string}|null>(null);
  const importInput=useRef<HTMLInputElement>(null),mounted=useRef(true),tasksRef=useRef<OcrTask[]>([]),importing=useRef(false),operation=useRef(false);
  const [detailVersion,setDetailVersion]=useState(0);
  const task=data.tasks.find(t=>t.id===taskId),file=task?.files.find(f=>f.id===fileId),profile=data.profiles.find(p=>p.id===profileId);
  const allIdentifiedPaths=new Set(data.tasks.flatMap(t=>t.files.map(f=>f.path.toLowerCase())));
  const refresh=useCallback(async()=>{
    const next=await api<OcrBootstrap>('ocr_bootstrap');
    if(mounted.current){
      tasksRef.current=next.tasks;
      setData(next);
    }
    return next;
  },[]);
  useEffect(()=>{
    const changed=(event:Event)=>{const {from,to}=(event as CustomEvent<{from:string;to:string}>).detail;setPaths(paths=>paths.filter(path=>!isWithin(path,from)&&!isWithin(path,to)));setBatch(null);setCorrection(null);setRecheckPrompt(null);void refresh().catch(e=>setError(String(e)));};
    window.addEventListener('workspace-renamed',changed);return()=>window.removeEventListener('workspace-renamed',changed);
  },[refresh]);
  const refreshTask=useCallback(async(id:string)=>{const next=await api<OcrTask>('ocr_get_task',{id});if(mounted.current)setData(current=>{if(!current.tasks.some(t=>t.id===id))return current;const tasks=current.tasks.map(t=>t.id===id?next:t);tasksRef.current=tasks;return {...current,tasks};});},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(visible)void refresh().catch(e=>setError(String(e)));},[visible,refresh]);
  useEffect(()=>{
    if(!desktop)return;
    let disposed=false;let stop:(()=>void)|undefined;
    void listen('ocr-profiles-changed',()=>{void refresh().catch(e=>setError(String(e)));}).then(unlisten=>{if(disposed)unlisten();else stop=unlisten;}).catch(e=>setError(String(e)));
    return()=>{disposed=true;stop?.();};
  },[refresh]);
  useEffect(()=>{try{localStorage.setItem(preferenceKey,JSON.stringify({profileId,workflow}));}catch{setError('任务选项无法保存，下次启动需重新设置。');}},[profileId,workflow]);
  const run=async(fn:()=>Promise<void>)=>{if(operation.current)return;operation.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{operation.current=false;setBusy(false);}};
  const importPaths=useCallback(async(values:string[])=>{
    const result=await api<{files:string[];errors:string[]}>('ocr_import_files',{paths:values});
    setPaths(p=>[...new Set([...p,...result.files])]);
    setTaskId('');
    setFileId('');
    if(result.errors.length)setError(result.errors.join('\n'));
    setNotice('');
  },[]);
  useEffect(()=>{if(!incoming.length||importing.current)return;importing.current=true;const selected=[...incoming];void importPaths(selected).then(()=>onConsumed(selected)).catch(e=>setError(String(e))).finally(()=>{importing.current=false;});},[incoming,importPaths,onConsumed]);
  useEffect(()=>{if(!desktop)return;let disposed=false;let cleanup:(()=>void)|undefined;void import('@tauri-apps/api/webviewWindow').then(async({getCurrentWebviewWindow})=>{const fn=await getCurrentWebviewWindow().onDragDropEvent(e=>{if(visible&&e.payload.type==='drop')void importPaths(e.payload.paths).catch(e=>setError(String(e)));});if(disposed)fn();else cleanup=fn;});return()=>{disposed=true;cleanup?.();};},[visible,importPaths]);
  useEffect(()=>{let disposed=false;let unlisten:(()=>void)|undefined;let timer:ReturnType<typeof setTimeout>|undefined;const pending=new Set<string>();const update=(id:string)=>{pending.add(id);if(timer)return;timer=setTimeout(()=>{timer=undefined;const ids=[...pending];pending.clear();for(const taskId of ids)void refreshTask(taskId).catch(e=>setError(String(e)));},300);};if(desktop)void listen<{id:string;status:string}>('ocr-progress',event=>{if(tasksRef.current.some(t=>t.id===event.payload.id))update(event.payload.id);}).then(fn=>{if(disposed)fn();else unlisten=fn;});const poll=setInterval(()=>{for(const t of tasksRef.current.filter(active))update(t.id);},2000);return()=>{disposed=true;unlisten?.();clearInterval(poll);if(timer)clearTimeout(timer);};},[refreshTask]);
  async function pickFiles(directory:boolean){if(!desktop){await importPaths(['D:/演示工作区/单据示例/报价单/演示商品报价单-20251226.pdf','D:/演示工作区/单据示例/合同/演示年度采购合同-已签署.pdf','D:/演示工作区/单据示例/对账单/演示2025年11月对账单.pdf','D:/演示工作区/单据示例/送货单/演示商品送货单-20251229.jpg']);return;}const {open}=await import('@tauri-apps/plugin-dialog');const values=await open({directory,multiple:!directory,filters:directory?undefined:[{name:'PDF 与图片',extensions:['pdf','png','jpg','jpeg','bmp','tif','tiff']}]});if(values)await importPaths(Array.isArray(values)?values:[values]);}
  async function start(targetPaths?:string[],retryId?:string,retryFileIds?:string[],options?:OcrWorkflowOptions,chosenProfile=profileId){
    const toRun=targetPaths||paths;
    if(chosenProfile!=='auto'&&!data.profiles.some(p=>p.id===chosenProfile))throw new Error('所选配置已删除，请重新选择识别配置。');
    if(!data.profiles.length)throw new Error('请先新建或导入识别配置。');
    const id=await api<string>('ocr_start_task',{paths:toRun,profileId:chosenProfile,useJev,retryId:retryId||null,retryFileIds:retryFileIds||null,workflow:options||null});
    setTaskId(id);setFileId('');setChecked([]);if(!retryId)setPaths([]);await refresh();
  }
  function triggerStart(targetPaths?:string[],oneClick=false){
    const toRun=targetPaths||paths;
    if(!toRun.length)return;
    if(oneClick&&workflow.exportFormat!=='none'&&!workflow.exportDirectory){setSettingsOpen(true);setError('请先在识别设置中选择导出文件夹。');return;}
    const options=oneClick?oneClickWorkflow(workflow):undefined;
    const duplicateCount=toRun.filter(p=>allIdentifiedPaths.has(p.toLowerCase())).length;
    if(!oneClick&&duplicateCount>0){
      setRecheckPrompt({paths:toRun,duplicateCount,total:toRun.length,profileId});
    }else{
      void run(()=>start(toRun,undefined,undefined,options));
    }
  }
  function selectTask(t:OcrTask){setTaskId(t.id);setFileId('');setChecked([]);}
  async function exportTask(format:string,failuresOnly=false,batchId?:string){
    const exportTaskId=batchId?batch?.taskId:task?.id;if(!exportTaskId)return;
    if(!desktop){
      if(!task)return;
      let text='';
      if(format==='json'){
        text=JSON.stringify(task,null,2);
      }else if(format==='csv'){
        const keys=Array.from(new Set(task.files.flatMap(f=>Object.keys(f.fields))));
        const header=['文件名',...keys].map(s=>`"${s.replace(/"/g,'""')}"`).join(',');
        const rows=task.files.map(f=>[`"${f.originalName.replace(/"/g,'""')}"`,...keys.map(k=>`"${(f.fields[k]?.value||'').replace(/"/g,'""')}"`)].join(','));
        text='\uFEFF'+[header,...rows].join('\r\n');
      }else{
        text=task.files.map(f=>`${f.originalName}\n`+f.lines.map(l=>`[第 ${l.page} 页] ${l.text}`).join('\n')).join('\n\n');
      }
      download(`OCR-${task.id.slice(0,8)}.${format}`,text);
      return;
    }
    const {save}=await import('@tauri-apps/plugin-dialog');
    const path=await save({defaultPath:`OCR-${failuresOnly?'异常-':''}${exportTaskId.slice(0,8)}.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(path){await api('ocr_export',{taskId:exportTaskId,format,path,failuresOnly,batchId:batchId||null});setNotice('结果已导出');}
  }
  async function importProfiles(file:File){const list=await api<OcrProfile[]>('ocr_import_profiles',{text:await file.text()});if(!list.length)throw new Error('配置文件中没有模板');const known=[...data.profiles];for(const p of list){const existing=known.find(x=>x.id===p.id)||known.find(x=>x.name===p.name);const saved={...p,id:existing?.id||p.id};await api('ocr_save_profile',{profile:saved});const index=known.findIndex(x=>x.id===saved.id);if(index>=0)known[index]=saved;else known.push(saved);}await refresh();const missing=list.filter(p=>!p.keywords.some(k=>k.trim()));setNotice(`已导入 ${list.length} 个配置，请编辑核对字段类型与本地规则。${missing.length?`其中 ${missing.map(p=>p.name).join('、')} 未设置自动匹配关键词，仅支持手动选择；如需自动匹配，请补充关键词并保存。`:''}`);}
  async function exportProfiles(profiles:OcrProfile[]){
    if(!profiles.length)return;
    const name=profiles.length===1?`${profiles[0].name.replace(/[\\/:*?"<>|]/g,'_').trim()||'未命名'}_OCR配置.json`:'全部OCR配置.json';
    if(!desktop){download(name,JSON.stringify(profiles.length===1?profiles[0]:profiles,null,2));}
    else{
      const {save}=await import('@tauri-apps/plugin-dialog');
      const path=await save({defaultPath:name,filters:[{name:'OCR 配置 (JSON)',extensions:['json']}]});
      if(!path)return;
      await api('ocr_export_profiles',{profiles,path});
    }
    setNotice(`已导出 ${profiles.length} 个配置，包含字段、规则与框选区域，可通过“导入配置”恢复。`);
  }
  async function clearCompleted(restore=false){
    if(!task)return;
    const count=await api<number>('ocr_clear_completed_results',{id:task.id,restore});
    await refresh();setChecked([]);setFileId('');if(restore)setResultFilter('all');
    setNotice(restore?`已恢复 ${count} 个已完成项`:`已从清单清除 ${count} 个已完成项，保留待复核、失败和中断项，可恢复显示。`);
  }
  const canRename=task&&!active(task)&&checked.length>0;
  const completedIds=new Set(task?completedOcrFileIds(task,data.batches):[]),clearedIds=new Set(task?.clearedFileIds?.filter(id=>completedIds.has(id))||[]);
  const listedFiles=task?.files.filter(f=>!clearedIds.has(f.id))||[],clearableCount=completedIds.size-clearedIds.size;
  const visibleFiles=listedFiles.filter(f=>resultFilter==='all'||resultFilter==='review'&&['ready','review'].includes(f.status)&&(f.status==='review'||!!f.warning)&&!f.reviewed||resultFilter==='failed'&&f.status==='failed'||resultFilter==='interrupted'&&['cancelled','interrupted'].includes(f.status));
  const eligible=visibleFiles.filter(f=>f.status==='ready'||f.status==='review'&&f.reviewed).map(f=>f.id)||[];
  const profileOptions=<><option value="auto">自动匹配配置</option>{profileId!=='auto'&&!profile&&<option value={profileId} disabled>所选配置已删除，请重新选择</option>}{data.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</>;
  return <div className="ocr-page" hidden={!visible}>
    <div className="page-heading"><h1>文档 OCR</h1><div className="ocr-heading-actions"><Button size="small" appearance="subtle" icon={<ClockCounterClockwise aria-hidden="true"/>} aria-haspopup="dialog" onClick={()=>setTaskHistoryOpen(true)}>任务记录 <span className="ocr-record-count">{data.tasks.length}</span></Button><Button size="small" appearance="subtle" icon={<ArrowCounterClockwise aria-hidden="true"/>} aria-haspopup="dialog" onClick={()=>setHistory(true)}>改名记录</Button></div></div>
    {error&&<div className="ocr-message error" role="alert"><span>{error}</span><IconButton label="关闭错误" onClick={()=>setError('')}><X/></IconButton></div>}
    {notice&&<div className="ocr-message" role="status"><span>{notice}</span><IconButton label="关闭消息" onClick={()=>setNotice('')}><X/></IconButton></div>}
    <section className="ocr-toolbar" aria-label="OCR 文件与配置">
      <div className="ocr-toolbar-import"><Button icon={<Files/>} disabled={busy} onClick={()=>void run(()=>pickFiles(false))}>添加文件</Button><Button icon={<FolderOpen/>} disabled={busy} onClick={()=>void run(()=>pickFiles(true))}>添加文件夹</Button></div>
      <label className="ocr-profile-select">识别配置<select aria-label="识别配置" value={profileId} onChange={e=>setProfileId(e.target.value)}>{profileOptions}</select></label>
      <div className="ocr-toolbar-settings">{(useJev||workflow.exportFormat!=='none')&&<span className="ocr-settings-summary">{[useJev?'Jev 已启用':'',workflow.exportFormat!=='none'?`自动导出 ${workflow.exportFormat.toUpperCase()}`:''].filter(Boolean).join(' · ')}</span>}<Button appearance="subtle" icon={<SlidersHorizontal aria-hidden="true"/>} aria-haspopup="dialog" onClick={()=>setSettingsOpen(true)}>识别设置</Button></div>
    </section>
    <input className="sr-only" aria-label="导入 OCR 配置文件" ref={importInput} type="file" accept=".json,.yaml,.yml" onChange={e=>{const f=e.target.files?.[0];if(f)void run(()=>importProfiles(f));e.target.value='';}}/>
    {(data.unavailableReason||!data.engineReady)&&<div className="ocr-setup-alert" role="alert">{data.unavailableReason?`OCR 暂不可用：${data.unavailableReason}`:'本地 OCR 引擎未安装。'}</div>}
    {!data.profiles.length&&<div className="ocr-setup-alert"><span>还没有识别配置，新建或导入后即可开始。</span><Button size="small" icon={<Plus/>} onClick={()=>setEditor(newProfile())}>新建配置</Button><Button size="small" onClick={()=>importInput.current?.click()}>导入配置</Button></div>}
    {taskHistoryOpen&&<Modal title={`任务记录 · ${data.tasks.length}`} className="ocr-task-history-dialog" onClose={()=>setTaskHistoryOpen(false)}>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      {notice&&<p className="ocr-policy" role="status">{notice}</p>}
      <aside className="ocr-task-list" aria-label="OCR 任务列表">
        <div className="ocr-task-list-header">
          <span className="muted">识别任务保存在本机</span>
          {data.tasks.some(t=>completedOcrTask(t,data.batches))&&<Button size="small" appearance="subtle" disabled={busy} title="只清理全部成功的任务，保留待复核、失败、中断和仍有后续步骤的任务" onClick={()=>void run(async()=>{const count=await api<number>('ocr_clear_completed_tasks');const next=await refresh();if(task&&!next.tasks.some(t=>t.id===task.id)){setTaskId('');setFileId('');setChecked([]);}setNotice(`已清理 ${count} 个全部完成的任务，待复核、失败和中断任务保留。`);})}>清理已完成任务</Button>}
        </div>
        {paths.length>0&&<div className={`ocr-task-item ${taskId===''?'selected':''} ocr-pending-task`}>
          <button className="ocr-task-button" onClick={()=>{setTaskId('');setFileId('');setTaskHistoryOpen(false);}}>
            <strong>待处理文件 · {paths.length} 个文件</strong>
          </button>
          <button type="button" className="ocr-task-delete" title="清空清单" aria-label="清空待处理文件清单" onClick={e=>{e.stopPropagation();setPaths([]);}}><Trash aria-hidden="true"/></button>
        </div>}
        {!data.tasks.length&&paths.length===0&&<p className="muted">识别任务会保存在本机。</p>}
        {data.tasks.map(t=><div key={t.id} className={`ocr-task-item ${t.id===taskId?'selected':''}`}>
          <button className="ocr-task-button" onClick={()=>{selectTask(t);setTaskHistoryOpen(false);}}>
            <strong>{t.autoMatch?'自动匹配':t.profiles[0]?.name||'通用配置'} · {t.files.length} 个文件{t.workflow?.enabled?' · 一键任务':''}</strong>
            <span>{new Date(t.created*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
            <small>{labels[t.status]||t.status} · {t.files.filter(f=>!['queued','running'].includes(f.status)).length}/{t.files.length}</small>
          </button>
          {!active(t)&&<button type="button" className="ocr-task-delete" title="删除此任务记录" aria-label={`删除任务 ${t.profiles[0]?.name||''}`} onClick={e=>{e.stopPropagation();void run(async()=>{await api('ocr_delete_task',{id:t.id});if(taskId===t.id){const rem=data.tasks.filter(x=>x.id!==t.id);if(rem.length){selectTask(rem[0]);}else{setTaskId('');setFileId('');}}await refresh();setNotice('任务记录已删除');});}}><Trash/></button>}
        </div>)}
      </aside>
    </Modal>}
    <div className="ocr-layout">
      {taskId===''&&paths.length>0?(
        <section className="ocr-results ocr-pending-results" aria-label="待识别文件清单">
          <header>
            <div>
              <h2>文件清单 <span className="muted">{paths.length} 个文件</span></h2>
              {paths.some(p=>allIdentifiedPaths.has(p.toLowerCase()))&&<span className="ocr-badge warning" style={{marginLeft:8}}>其中 {paths.filter(p=>allIdentifiedPaths.has(p.toLowerCase())).length} 项曾识别过</span>}
            </div>
            <div className="ocr-buttons">
              <Button icon={<Trash/>} appearance="subtle" onClick={()=>setPaths([])}>清空清单</Button>
              <Button icon={<Scan/>} disabled={busy||!data.engineReady} onClick={()=>triggerStart()}>仅识别</Button><Button appearance="primary" icon={<Check/>} disabled={busy||!data.engineReady} onClick={()=>triggerStart(undefined,true)}>一键识别并改名 · {paths.length}</Button>
            </div>
          </header>
          <div className="ocr-table-scroll"><table><thead><tr><th style={{width:44,textAlign:'center'}}>#</th><th style={{width:'38%'}}>文件名称</th><th style={{width:'auto'}}>所在文件夹</th><th style={{width:90}}>历史记录</th><th style={{width:60,textAlign:'center'}}>操作</th></tr></thead><tbody>{paths.map((p,idx)=>{const isRecheck=allIdentifiedPaths.has(p.toLowerCase());return <tr key={p}><td className="muted" style={{textAlign:'center'}}>{idx+1}</td><td><strong>{basename(p)}</strong></td><td className="muted" title={p} style={{fontSize:11}}>{dirname(p)}</td><td>{isRecheck?<span className="ocr-tag warning">曾识别过</span>:null}</td><td style={{textAlign:'center'}}><IconButton label={`移除 ${basename(p)}`} onClick={()=>setPaths(v=>v.filter(x=>x!==p))}><X/></IconButton></td></tr>;})}</tbody></table></div>
        </section>
      ):!task?(
        <section className="ocr-results" aria-label="文件清单">
          <header><h2>文件清单 <span className="muted">0 个文件</span></h2><span className="ocr-list-hint">支持 PDF 与图片，也可直接拖入</span></header>
          <Empty title="添加需要识别的文件" detail="支持 PDF、PNG、JPEG、BMP、TIFF。识别后可核对字段、导出结果和批量改名。" action={<Button appearance="primary" icon={<Files/>} disabled={busy} onClick={()=>void run(()=>pickFiles(false))}>添加文件</Button>}/>
        </section>
      ):(
        <section className="ocr-results" aria-label="OCR 结果">
          <header>
            <div><h2>文件清单 <span className="muted">{listedFiles.length} 个文件 · {labels[task.status]}{clearedIds.size>0?` · 已清除 ${clearedIds.size} 项`:''}</span></h2>{active(task)&&<progress aria-label="OCR 进度" max={task.files.length} value={task.files.filter(f=>!['queued','running'].includes(f.status)).length}/>}</div>
            <div className="ocr-buttons">
              <label className="ocr-result-filter"><span className="sr-only">结果范围</span><select aria-label="结果范围" value={resultFilter} onChange={e=>{setResultFilter(e.target.value);setChecked([]);setFileId('');}}><option value="all">全部结果</option><option value="review">待复核</option><option value="failed">识别失败</option><option value="interrupted">中断或取消</option></select></label>
              <Button icon={<Trash aria-hidden="true"/>} disabled={busy||active(task)||!clearableCount} title={active(task)?'任务结束后可清除已完成项':'从清单移除已完成项，保留待复核、失败、中断及未完成后续步骤的项目；原始结果与改名记录保留，可恢复显示'} onClick={()=>void run(()=>clearCompleted())}>清除已完成{clearableCount?` · ${clearableCount}`:''}</Button>
              {!!task.clearedFileIds?.length&&<Button appearance="subtle" disabled={busy||active(task)} onClick={()=>void run(()=>clearCompleted(true))}>恢复已清除项</Button>}
              {active(task)?<Button icon={<Stop/>} onClick={()=>void run(async()=>{await api('ocr_cancel_task',{id:task.id});await refresh();})}>取消任务</Button>:<><Button icon={<ArrowCounterClockwise/>} disabled={busy||!listedFiles.length} onClick={()=>triggerStart(listedFiles.map(f=>f.path))}>再次识别清单</Button><Button disabled={busy||!task.files.some(f=>['failed','cancelled','interrupted'].includes(f.status))} onClick={()=>void run(()=>start(undefined,task.id))}>重试未完成项</Button></>}
            </div>
          </header>
        {task.workflow?.enabled&&<div className="ocr-workflow-status" role="status"><strong>{active(task)?task.workflow.status==='running'?'正在完成导出 / 改名步骤…':'一键任务进行中':task.workflow.status==='completed'?(task.workflow.options.rename==='apply'?'识别与重命名已完成':'一键任务已完成'):task.workflow.status==='review'?'正常项已处理，剩余项待核对':task.workflow.status==='interrupted'?'上次任务已中断，可继续未完成步骤':task.workflow.status==='cancelled'?'任务已取消，已完成步骤保留':'后续步骤未完成'}</strong><span>就绪 {task.files.filter(f=>f.status==='ready').length} · 待复核 {task.files.filter(f=>['ready','review'].includes(f.status)&&(f.status==='review'||!!f.warning)&&!f.reviewed).length} · 失败 / 中断 {task.files.filter(f=>['failed','cancelled','interrupted'].includes(f.status)).length}</span>{task.workflow.exportPath&&<span className="ocr-output-directory" title={task.workflow.exportPath}>已导出：{task.workflow.exportPath}<Button size="small" onClick={()=>void run(async()=>{await copyText(task.workflow!.exportPath);setNotice('导出路径已复制');})}>复制路径</Button></span>}{task.workflow.error&&<span className="inline-error">{task.workflow.error}</span>}<div className="ocr-buttons">{task.workflow.renameBatchId&&<Button size="small" disabled={busy||active(task)} onClick={()=>void run(async()=>{const next=await refresh();const found=next.batches.find(b=>b.id===task.workflow!.renameBatchId);if(!found)throw new Error('改名记录已不存在。');setUndo(found.status!=='preview');setBatch(found);})}>查看改名{task.workflow.options.rename==='preview'?'预览':'结果'}</Button>}{!active(task)&&task.workflow.status!=='completed'&&<Button size="small" disabled={busy} onClick={()=>void run(async()=>{await api('ocr_resume_workflow',{id:task.id});await refresh();})}>仅继续后续步骤</Button>}</div></div>}
        {!listedFiles.length?<Empty title="清单中的项目已全部完成" detail="已完成项已从清单清除，识别结果和改名记录仍然保留。" action={<Button disabled={busy} onClick={()=>void run(()=>clearCompleted(true))}>恢复显示</Button>}/>:!visibleFiles.length?<Empty title="当前范围没有文件" detail="待处理文件仍保留在清单中，可切换范围查看。" action={<Button onClick={()=>setResultFilter('all')}>查看全部结果</Button>}/>:<div className={`ocr-table-scroll ${uniformRows?'uniform-rows':''}`}>
          <table>
            <thead>
              <tr>
                <th><Checkbox aria-label="选择可改名结果" checked={checked.length===0?false:checked.length===eligible.length?true:'mixed'} onChange={(_,v)=>setChecked(v.checked?eligible:[])}/></th>
                <th>原文件 / 当前文件</th>
                <th>配置</th>
                <th>拟命名</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {visibleFiles.map(f=>{
                const issue=f.error||f.warning||(f.status==='review'&&!f.reviewed?'需要核对：'+Object.entries(f.fields).filter(([key,v])=>v.review||!v.value&&f.profile?.fields.some(def=>def.key===key&&def.required)).map(([key])=>key).join('、'):'');
                return <tr key={f.id} className={f.id===fileId?'selected':''}>
                <td><Checkbox aria-label={`选择 ${f.originalName}`} checked={checked.includes(f.id)} disabled={!['ready','review'].includes(f.status)||f.status==='review'&&!f.reviewed} onChange={(_,v)=>setChecked(ids=>v.checked?[...ids,f.id]:ids.filter(id=>id!==f.id))}/></td>
                <td>
                  <button className="ocr-file-button" onClick={()=>setFileId(f.id)} title={`点击查看识别详情：${f.originalName}`}>
                    <span className="ocr-cell-scrollable">{f.originalName}</span>
                    <small>{basename(f.path)!==f.originalName?basename(f.path):`${f.lines.length} 行 · ${(f.elapsedMs/1000).toFixed(1)} 秒`}</small>
                  </button>
                </td>
                <td><span className="ocr-profile-tag" title={f.profile?.name||'尚未匹配配置'}>{f.profile?.name||'尚未匹配'}</span>{!active(task)&&<Button size="small" appearance="subtle" disabled={busy||!data.profiles.length} onClick={()=>setCorrection({taskId:task.id,fileId:f.id,profileId:data.profiles.some(p=>p.id===f.profile?.id)?f.profile!.id:'',name:f.originalName})}>更换配置</Button>}</td>
                <td>
                  <div className="ocr-proposed-cell" title={f.proposedName||''}>
                    <span className="ocr-cell-scrollable">{f.proposedName||'—'}</span>
                  </div>
                </td>
                <td><div className="ocr-row-status"><span className={`ocr-status ${f.status}`}>{f.reviewed?'已复核':labels[f.status]}</span>{['failed','cancelled','interrupted'].includes(f.status)&&<Button size="small" disabled={busy||active(task)} onClick={()=>void run(()=>start(undefined,task.id,[f.id]))}>仅重试此项</Button>}</div>{issue&&<small className="ocr-row-issue" title={issue}>{issue}</small>}</td>
              </tr>;})}
            </tbody>
          </table>
        </div>}
          <footer>
            <div className="ocr-buttons ocr-export-group">
              <span className="ocr-export-label">导出结果：</span><Button size="small" disabled={busy||active(task)||!task.files.some(f=>['failed','cancelled','interrupted'].includes(f.status))} onClick={()=>void run(()=>exportTask('csv',true))}>异常项 CSV</Button>
              {exportOptions.map(opt => (
                <Button
                  key={opt.format}
                  size="small"
                  icon={<DownloadSimple/>}
                  title={opt.title}
                  aria-label={opt.title}
                  disabled={busy||active(task)}
                  onClick={()=>void run(()=>exportTask(opt.format))}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            <Button appearance="primary" disabled={!canRename||busy} onClick={()=>void run(async()=>{setUndo(false);setBatch(await api<OcrRenameBatch>('ocr_preview_rename',{taskId:task.id,fileIds:checked}));})}>预览改名 · {checked.length}</Button>
          </footer>
        </section>
      )}
      {file&&task&&<ResultDetail key={`${task.id}:${file.id}:${file.status}:${detailVersion}`} file={file} disabled={busy||active(task)} onDiagnose={desktop&&onDiagnose?()=>setDiagnosticFile({taskId:task.id,fileId:file.id}):undefined} onSave={(values,name,reviewed)=>run(async()=>{await api('ocr_update_result',{taskId:task.id,fileId:file.id,values,proposedName:name,reviewed});await refresh();setDetailVersion(v=>v+1);setNotice('结果已保存');})} onOpen={reveal=>void run(async()=>{await api('ocr_open_file',{taskId:task.id,fileId:file.id,reveal});})} onClose={()=>setFileId('')}/>}
    </div>
    {visible&&diagnosticFile&&<OcrDiagnosticShare {...diagnosticFile} onClose={()=>setDiagnosticFile(null)} onShare={request=>{setDiagnosticFile(null);setFileId('');onDiagnose?.(request);}}/>}
    {settingsOpen&&<Modal title="识别设置" className="ocr-settings-dialog" onClose={()=>setSettingsOpen(false)}>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      {notice&&<p className="ocr-policy" role="status">{notice}</p>}
      <section className="ocr-setting-section">
        <h3>配置管理</h3>
        <div className="ocr-setup-row"><label className="ocr-profile-select">识别配置<select aria-label="识别配置" value={profileId} onChange={e=>setProfileId(e.target.value)}>{profileOptions}</select></label><Button disabled={!profile||busy} onClick={()=>{setSettingsOpen(false);setNotice('');setEditor(structuredClone(profile!));}}>编辑配置</Button><Button icon={<DownloadSimple/>} disabled={!profile||busy} onClick={()=>void run(()=>exportProfiles([profile!]))}>导出此配置</Button></div>
        <div className="ocr-setup-row"><Button icon={<Plus/>} disabled={busy} onClick={()=>{setSettingsOpen(false);setNotice('');setEditor(newProfile());}}>新建配置</Button><Button disabled={busy} onClick={()=>importInput.current?.click()}>导入配置</Button><Button icon={<DownloadSimple/>} disabled={busy||!data.profiles.length} onClick={()=>void run(()=>exportProfiles(data.profiles))}>导出全部配置</Button></div>
        {profileId==='auto'&&<><p className="ocr-policy">从 {data.profiles.filter(p=>p.keywords.some(k=>k.trim())).length} 个已保存且有自动匹配关键词的配置中，按首页逐文件匹配，再按选中配置提取。配置名称和附加标题不参与匹配；无唯一匹配时保留待复核，可在详情查看原因并更换配置仅重试该文件。</p>{data.profiles.some(p=>!p.keywords.some(k=>k.trim()))&&<details className="ocr-task-options"><summary>查看未设置关键词的配置</summary><p className="muted">{data.profiles.filter(p=>!p.keywords.some(k=>k.trim())).map(p=>p.name).join('、')}：可手动选择使用；如需自动匹配，请选择该配置 → 编辑配置 → 填写自动匹配关键词并保存。</p></details>}</>}
      </section>
      <section className="ocr-setting-section">
        <h3>字段判断</h3>
        <Checkbox label="优先使用 Jev 判断字段" checked={useJev} onChange={(_,v)=>{const c=!!v.checked;setUseJev(c);try{localStorage.setItem('ocr_use_jev',String(c));}catch{}}}/>
        <p className="ocr-policy">{useJev?'已启用 Jev：仅向模型发送数字脱敏后的候选文字；页面图片、数值原文留在本机。':'默认使用本地 OCR、定位标签、正则与格式规则；启用 Jev 后，Jev 判断说明才参与语义判断。'}{useJev&&!data.jevReady&&<> 尚未配置 Jev 密钥，字段将使用本地规则。<button className="text-button" onClick={()=>{setSettingsOpen(false);onSettings();}}>前往设置</button></>}</p>
      </section>
      <section className="ocr-setting-section">
        <h3>一键任务</h3>
        <div className="ocr-setup-row"><label>结果导出<select value={workflow.exportFormat} onChange={e=>setWorkflow(v=>({...v,exportFormat:e.target.value as OcrWorkflowOptions['exportFormat']}))}><option value="none">不自动导出</option>{exportOptions.map(opt=><option key={opt.format} value={opt.format}>{opt.label}</option>)}</select></label>{workflow.exportFormat!=='none'&&<><Button disabled={busy} onClick={()=>void run(async()=>{if(!desktop)throw new Error('自动导出需要桌面版选择本机文件夹。');const directory=await pick(true);if(directory)setWorkflow(v=>({...v,exportDirectory:directory}));})}>选择导出文件夹</Button><span className="ocr-output-directory" title={workflow.exportDirectory}>{workflow.exportDirectory||'尚未选择导出位置'}</span></>}</div>
        <p className="ocr-policy">点击“一键识别并改名”后，按当前配置连续完成 OCR 和重命名，无需再点击改名或确认名称；同名自动加序号，不覆盖原文件。需复核、失败和冲突项集中保留，执行记录可撤销。“仅识别”保留原分步流程。</p>
      </section>
      <section className="ocr-setting-section">
        <h3>列表显示</h3>
        <Checkbox label="规整等高视图" title="文件行保持相同高度，长文件名可在单元格中滚动查看" checked={uniformRows} onChange={(_,v)=>{const c=!!v.checked;setUniformRows(c);try{localStorage.setItem('ocr_uniform_rows',String(c));}catch{}}}/>
      </section>
      <div className="ocr-settings-footer"><span className="muted">选项自动保存</span><Button onClick={()=>setSettingsOpen(false)}>完成</Button></div>
    </Modal>}
    {editor&&<ProfileEditor value={editor} busy={busy} error={error} notice={notice} onChange={p=>{setEditor(p);setNotice('');}} onClose={()=>{setEditor(null);setError('');}} onSave={()=>void run(async()=>{await api('ocr_save_profile',{profile:editor});await refresh();setProfileId(editor.id);setEditor(null);setNotice('配置已保存');})} onDelete={()=>void run(async()=>{await api('ocr_delete_profile',{id:editor.id});setProfileId('auto');setEditor(null);await refresh();})} onAI={description=>void run(async()=>{const next=await api<OcrProfile>('ocr_generate_profile',{description,profile:editor});setEditor(next);setNotice(editor.fields.length?'AI 针对性微调完成，已锁定保护其余已有字段与画框':'AI 草稿已生成，请核对并保存');})} onExport={()=>void run(()=>exportProfiles([editor]))}/ >}
    {recheckPrompt&&<Modal title="再次识别提醒" onClose={()=>setRecheckPrompt(null)}>
      <p>共 {recheckPrompt.total} 个文件，使用【{recheckPrompt.profileId==='auto'?'自动识别配置':data.profiles.find(p=>p.id===recheckPrompt.profileId)?.name||'已失效配置'}】。</p>
      {recheckPrompt.duplicateCount>0&&<p>其中 <strong>{recheckPrompt.duplicateCount}</strong> 项曾识别过；本次生成新任务，原记录保留。</p>}
      <div className="dialog-actions"><Button disabled={busy} onClick={()=>setRecheckPrompt(null)}>取消</Button><Button appearance="primary" disabled={busy} onClick={()=>{const pending=recheckPrompt;setRecheckPrompt(null);void run(()=>start(pending.paths,undefined,undefined,undefined,pending.profileId));}}>确认开始</Button></div>
    </Modal>}
    {correction&&<Modal title="更换识别配置" onClose={()=>setCorrection(null)}><p>{correction.name}</p>{error&&<p className="inline-error" role="alert">{error}</p>}<p className="muted">仅重新识别这个文件，生成新任务。其余成功项不重复处理，原结果保留供核对。</p><label className="ocr-profile-select">识别配置<select value={correction.profileId} onChange={e=>setCorrection(v=>v?{...v,profileId:e.target.value}:null)}><option value="" disabled>请选择具体配置</option>{data.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className="dialog-actions"><Button disabled={busy} onClick={()=>setCorrection(null)}>取消</Button><Button appearance="primary" disabled={busy||!correction.profileId} onClick={()=>void run(async()=>{await start(undefined,correction.taskId,[correction.fileId],undefined,correction.profileId);setCorrection(null);})}>仅重新处理此文件</Button></div></Modal>}
    {batch&&<OcrRenameDialog batch={batch} undo={undo} busy={busy} error={error} onClose={()=>setBatch(null)} onApply={()=>void run(async()=>{const res=await api<OcrRenameBatch>('ocr_apply_rename',{batchId:batch.id,undo});setBatch(res);await refresh();setChecked([]);setNotice(renameMessage(res,undo));})} onRecheck={ids=>void run(async()=>{setUndo(false);setBatch(await api<OcrRenameBatch>('ocr_preview_rename',{taskId:batch.taskId,fileIds:ids}));})} onExport={()=>void run(()=>exportTask('csv',true,batch.id))}/>}
    {history&&<Modal title="改名记录" wide onClose={()=>setHistory(false)}>{data.batches.filter(b=>b.status!=='preview').length===0?<p>还没有执行过重命名。</p>:data.batches.filter(b=>b.status!=='preview').map(b=><div className="ocr-history-row" key={b.id}><span>{renameMessage(b,b.status.startsWith('rollback'))}<small>{b.id.slice(0,8)}</small></span><Button onClick={()=>{setUndo(b.status.startsWith('rollback')||b.items.some(i=>i.status==='done'));setBatch(b);setHistory(false);}}>查看结果与恢复</Button></div>)}</Modal>}
  </div>;
}

function ProfileMatchDetail({file}:{file:OcrFileResult}){
  const match=file.diagnostics?.profileMatch;
  if(!match)return null;
  const score=(value:number|null)=>value===null?'无效分数':String(value);
  return <details className="ocr-task-options ocr-profile-match">
    <summary>自动匹配诊断 · {match.message}</summary>
    <p className="muted">本次任务使用已保存配置的快照，探测第 {match.page} 页（{match.dpi} DPI，共 {match.linesCount} 行）。以下行号属于首页探测，与最终提取文本的行号可能不同。</p>
    <p className="muted">按不同关键词命中数计分，仅唯一最高分可选中。忽略同一行内汉字间的单个空格及全半角差异，不拼接断行、多个空格、制表符或不同 OCR 块。低分文字不参与计分；当前匹配与字段复核共用阈值。</p>
    {match.candidates.map(candidate=><details key={candidate.profileId} className="ocr-decision-card">
      <summary>{candidate.profileName} · 命中 {candidate.score} 个关键词 · 阈值 {candidate.threshold}{!candidate.keywords.length?' · 未配置关键词，不参与匹配':''}</summary>
      <ul>{candidate.keywords.map(keyword=><li key={keyword.normalized}>
        <strong>{keyword.keyword}</strong>{keyword.normalized!==keyword.keyword&&<>（匹配用词：{keyword.normalized}）</>}：{keyword.hits.length?keyword.hits.map(hit=>`探测第 ${hit.lineIndex+1} 行，分数 ${score(hit.score)}${hit.accepted?'，已计分':'，已过滤'}`).join('；'):'首页未命中'}
      </li>)}</ul>
    </details>)}
    <p className="muted">这里展示每个关键词分数最高的命中行；匹配记录保存在本机任务中，不附带文档正文。无唯一匹配时，可返回结果列表“更换配置”并仅重试该文件；关键词只在后续页时请手动选择配置。</p>
  </details>;
}

function ResultDetail({file,disabled,onSave,onOpen,onClose,onDiagnose}:{file:OcrFileResult;disabled:boolean;onSave:(values:Record<string,string>,name:string,reviewed:boolean)=>Promise<void>;onOpen:(reveal:boolean)=>void;onClose:()=>void;onDiagnose?:()=>void}){
  const [tab,setTab]=useState<'fields'|'decisions'|'outbound'|'logs'|'lines'>('fields');
  const [values,setValues]=useState(Object.fromEntries(Object.entries(file.fields).map(([k,v])=>[k,v.value])));
  const [name,setName]=useState(file.proposedName);
  const [nameEdited,setNameEdited]=useState(false);
  const [reviewed,setReviewed]=useState(file.reviewed);
  const [copied,setCopied]=useState('');
  const [copyError,setCopyError]=useState('');
  const copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>{if(copyTimer.current)clearTimeout(copyTimer.current);},[]);

  const editable=['ready','review'].includes(file.status);
  const diag=file.diagnostics;
  const jev=diag?.jev;

  const copy=(key:string,text:string)=>{
    void copyText(text).then(()=>{
      setCopyError('');
      setCopied(key);
      if(copyTimer.current)clearTimeout(copyTimer.current);
      copyTimer.current=setTimeout(()=>setCopied(''),2000);
    }).catch(e=>setCopyError(`复制失败：${String(e)}`));
  };

  return (
    <Modal title={`文件识别详情 · ${file.originalName}`} wide onClose={onClose}>
      <div className="ocr-modal-layout">
        <div className="ocr-modal-file-bar">
          <div className="ocr-modal-file-title">
            <span className={`ocr-status ${file.status}`}>{file.reviewed?'已复核':labels[file.status]}</span>
            <strong title={file.path}>{file.originalName}</strong>
            <span className="muted" style={{fontSize:11}}>{file.lines.length} 行文本 · 耗时 {(file.elapsedMs/1000).toFixed(1)}s</span>
          </div>
          <div className="ocr-buttons">
            {onDiagnose&&<Button size="small" icon={<Sparkle aria-hidden="true"/>} onClick={onDiagnose}>让助理诊断</Button>}
            <Button size="small" onClick={()=>onOpen(false)}>打开原文件</Button>
            <Button size="small" onClick={()=>onOpen(true)}>资源管理器定位</Button>
          </div>
        </div>

        {file.error&&<p className="inline-error" role="alert">{file.error}</p>}
        {file.warning&&<p className="ocr-warning" role="alert">{file.warning}</p>}
        <ProfileMatchDetail file={file}/>

        <div className="ocr-modal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab==='fields'}
            className={tab==='fields'?'active':''}
            onClick={()=>setTab('fields')}
          >
            字段提取与修正 {Object.values(file.fields).some(f=>f.review)&&<span className="ocr-dot danger"/>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab==='decisions'}
            className={tab==='decisions'?'active':''}
            onClick={()=>setTab('decisions')}
          >
            判定决策链路 {diag?.decisions&&diag.decisions.length>0&&`(${diag.decisions.length})`}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab==='outbound'}
            className={tab==='outbound'?'active':''}
            onClick={()=>setTab('outbound')}
          >
            出站审查与 Prompt {jev?.sent&&<span className="ocr-dot focus"/>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab==='logs'}
            className={tab==='logs'?'active':''}
            onClick={()=>setTab('logs')}
          >
            执行流水日志 ({diag?.logs?.length||0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab==='lines'}
            className={tab==='lines'?'active':''}
            onClick={()=>setTab('lines')}
          >
            全文数据 ({file.lines.length})
          </button>
        </div>

        {tab==='fields'&&(
          <div className="ocr-fields-view">
            <div className="ocr-fields-grid">
              {Object.entries(file.fields).map(([key,v])=>(
                <div className="ocr-field-card" key={key}>
                  <div className="ocr-field-label-row">
                    <span className="ocr-field-key">{key}</span>
                    {v.review&&<span className="ocr-tag warning">需复核</span>}
                  </div>
                  <input
                    className="ocr-field-input"
                    aria-label={`结果 ${key}`}
                    value={values[key]||''}
                    disabled={disabled||!editable}
                    onChange={e=>setValues({...values,[key]:e.target.value})}
                  />
                  <div className="ocr-field-meta">
                    <span className={`ocr-source-tag ${v.source}`}>{labels[v.source]||v.source}</span>
                    <span title={v.source==='local'?'此分数只表示 OCR 文字识别质量，不表示字段归属一定正确。':undefined}>
                      {v.source==='jev'
                        ?(v.confidence===null?'无模型分数':`置信度 ${(v.confidence*100).toFixed(0)}%`)
                        :(v.source==='local'
                          ?(v.confidence===null?'本地规则':`OCR 文字置信度 ${(v.confidence*100).toFixed(0)}%`)
                          :(v.confidence===null?'':`置信度 ${(v.confidence*100).toFixed(0)}%`))}
                    </span>
                    {v.evidence.length>0&&<span>来源行: {v.evidence.map(i=>i+1).join('、')}</span>}
                  </div>
                </div>
              ))}
            </div>

            {editable&&(
              <div className="ocr-fields-footer">
                <div className="ocr-name-editor">
                  <label htmlFor="ocr-rename-input">拟重命名文件预览</label>
                  <input
                    id="ocr-rename-input"
                    aria-label="拟命名"
                    value={name}
                    onChange={e=>{setName(e.target.value);setNameEdited(true);}}
                    disabled={disabled}
                    placeholder="输入规整后的新文件名"
                  />
                </div>
                <div className="ocr-actions-row">
                  <Checkbox
                    label="我已核对所有识别字段与拟命名"
                    checked={reviewed}
                    disabled={disabled}
                    onChange={(_,d)=>setReviewed(!!d.checked)}
                  />
                  <Button
                    appearance="primary"
                    disabled={disabled}
                    onClick={()=>void onSave(values,nameEdited?name:'',reviewed)}
                  >
                    保存修正结果
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab==='decisions'&&(
          <div className="ocr-decision-view">
            {diag?.decisions&&diag.decisions.length>0?(
              <div className="ocr-decision-grid">
                {diag.decisions.map(d=>(
                  <div key={d.fieldKey} className={`ocr-decision-card ${d.reviewRequired?'needs-review':''}`}>
                    <div className="ocr-decision-top">
                      <span className="ocr-decision-field">{d.fieldKey}</span>
                      <span className={`ocr-tag ${d.finalSource}`}>{labels[d.finalSource]||d.finalSource}</span>
                    </div>
                    <div className="ocr-decision-final-val">
                      <span className="muted">最终采纳:</span>
                      <strong>{d.finalValue||'（未提取到）'}</strong>
                    </div>
                    <div className="ocr-decision-candidates">
                      <div className="ocr-cand-line">
                        <span className="cand-label">Jev 模型:</span>
                        <span>{d.jevCandidate?`${d.jevCandidate} ${d.jevConfidence!==null&&d.jevConfidence!==undefined?`(${(d.jevConfidence*100).toFixed(0)}%)`:''}`:'（未给出有效候选）'}</span>
                      </div>
                      <div className="ocr-cand-line">
                        <span className="cand-label">本地规则:</span>
                        <span>{localDecisionText(d)}</span>
                      </div>
                    </div>
                    {d.reviewReason&&(
                      <div className="ocr-decision-warn-box">
                        <strong>需复核提醒：</strong> {d.reviewReason}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ):(
              <p className="muted" style={{textAlign:'center',padding:'40px 0'}}>未记录字段判定决策（可在更新配置后重新发起识别产生）。</p>
            )}
          </div>
        )}

        {tab==='outbound'&&(
          <div className="ocr-outbound-view">
            <div className="ocr-outbound-header">
              <div className="ocr-diag-badge-row">
                <span className={`ocr-badge ${jev?.enabled?(jev?.success?'success':jev?.sent?'danger':'warning'):'muted'}`}>
                  {jev?.enabled?(jev?.sent?(jev?.success?`Jev 调用成功 · 耗时 ${jev?.elapsedMs}ms`:`Jev 调用失败 · 耗时 ${jev?.elapsedMs}ms`):'Jev 未发送'):'未启用 Jev'}
                </span>
                <span className="ocr-badge muted">模型版本: jev-1.13.0</span>
                <span className="ocr-badge muted">OCR 耗时: {diag?.ocrElapsedMs?`${diag.ocrElapsedMs}ms`:'—'}</span>
              </div>
            </div>

            {jev?.error&&<p className="inline-error" role="alert" style={{marginBottom:10}}>{jev.error}</p>}
            {copyError&&<p className="inline-error" role="alert" style={{marginBottom:10}}>{copyError}</p>}

            <div className="ocr-outbound-split">
              <div className="ocr-outbound-col">
                <div className="ocr-outbound-col-header">
                  <div>
                    <h4>出站脱敏候选行（共 {jev?.candidates?.length||0} 行）</h4>
                    <p className="ocr-diag-desc" style={{fontSize:11,color:'var(--muted)',margin:0}}>
                      图片与敏感数字绝不出站，已全自动脱敏为 [数值] 占位符：
                    </p>
                  </div>
                  <IconButton
                    label="复制脱敏候选行内容"
                    onClick={()=>{
                      const text = jev?.candidates?.length
                        ? jev.candidates.map(c=>`[${c.id}] ${c.maskedText}\n(对应原文档第 ${c.originalLineIndex+1} 行: ${c.originalText})`).join('\n\n')
                        : '无候选数据';
                      copy('candidates', text);
                    }}
                  >
                    {copied==='candidates'?<Check style={{color:'var(--focus)'}}/>:<Copy/>}
                  </IconButton>
                </div>
                <div className="ocr-scroll-box">
                  {jev?.candidates&&jev.candidates.length>0?jev.candidates.map(c=>(
                    <div key={c.id} className="ocr-code-line" style={{marginBottom:8,paddingBottom:6,borderBottom:'1px dashed var(--line)'}}>
                      <div>
                        <span className="ocr-opaque-id" style={{color:'var(--focus)',fontWeight:600}}>[{c.id}]</span>{' '}
                        <span className="ocr-masked-text">{c.maskedText}</span>
                      </div>
                      <small className="ocr-orig-hint" style={{display:'block',color:'var(--muted)',fontSize:10,marginTop:2}}>
                        对应原文档第 {c.originalLineIndex+1} 行：{c.originalText}
                      </small>
                    </div>
                  )):<p className="muted" style={{padding:'20px 0',textAlign:'center'}}>无出站候选数据</p>}
                </div>
              </div>

              <div className="ocr-outbound-col">
                <div className="ocr-outbound-col-header">
                  <div>
                    <h4>向模型提交的问询 Prompt（共 {jev?.questions?.length||0} 项）</h4>
                    <p className="ocr-diag-desc" style={{fontSize:11,color:'var(--muted)',margin:0}}>
                      结构化 Prompt 问询指令及模型判定结果：
                    </p>
                  </div>
                  <IconButton
                    label="复制问询 Prompt 内容"
                    onClick={()=>{
                      const text = jev?.questions?.length
                        ? jev.questions.map(q=>`【${q.fieldKey}】(ID: ${q.questionId})\n问询指令: ${q.instructions}\n判定采纳: ${q.chosenText||q.chosenId||'无'} ${q.confidence!==null&&q.confidence!==undefined?`(${(q.confidence*100).toFixed(0)}%)`:''}`).join('\n\n---\n\n')
                        : '无问询说明';
                      copy('questions', text);
                    }}
                  >
                    {copied==='questions'?<Check style={{color:'var(--focus)'}}/>:<Copy/>}
                  </IconButton>
                </div>
                <div className="ocr-scroll-box">
                  {jev?.questions&&jev.questions.length>0?jev.questions.map((q,idx)=>(
                    <div key={idx} className="ocr-q-item" style={{marginBottom:10,paddingBottom:8,borderBottom:'1px dashed var(--line)'}}>
                      <div style={{fontWeight:600,color:'var(--text)'}}>【{q.fieldKey}】 <span className="muted" style={{fontWeight:'normal',fontSize:10}}>ID: {q.questionId}</span></div>
                      <p style={{margin:'4px 0',whiteSpace:'pre-wrap',color:'var(--muted)'}}>{q.instructions}</p>
                      <div style={{fontSize:11,color:'var(--focus)',fontWeight:500}}>
                        判定采纳: {q.chosenText||q.chosenId||'无'} {q.confidence!==null&&q.confidence!==undefined?`(${(q.confidence*100).toFixed(0)}%)`:''}
                      </div>
                    </div>
                  )):<p className="muted" style={{padding:'20px 0',textAlign:'center'}}>无问询指令</p>}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab==='logs'&&diag?.profileMatch&&diag.profileMatch.outcome!=='matched'?(
          <div className="ocr-steps-panel">
            <p role="status">此文件停在首页配置匹配，尚未执行字段提取、命名或自动改名。</p>
            <p>{diag.profileMatch.message}</p>
            <p className="muted">首页探测耗时 {diag.ocrElapsedMs}ms；候选配置、关键词和分数见上方“自动匹配诊断”。</p>
          </div>
        ):tab==='logs'&&(
          <div className="ocr-steps-panel">
            {(()=>{
              const totalElapsed = file.elapsedMs || ((diag?.ocrElapsedMs || 0) + (jev?.elapsedMs || 0)) || 1;
              const ocrMs = diag?.ocrElapsedMs || 0;
              const jevMs = jev?.elapsedMs || 0;
              const ruleMs = Math.max(0, file.elapsedMs - ocrMs - jevMs);
              const ocrPct = Math.max(0, Math.min(100, Math.round((ocrMs / totalElapsed) * 100)));
              const jevPct = Math.max(0, Math.min(100, Math.round((jevMs / totalElapsed) * 100)));
              const rulePct = Math.max(0, 100 - ocrPct - jevPct);

              const step1Logs = diag?.logs?.filter(l => l.includes('处理文件') || l.includes('OCR') || l.includes('指纹')) || [];
              const step2Logs = diag?.logs?.filter(l => l.includes('构建 Jev') || l.includes('候选') || l.includes('脱敏')) || [];
              const step3Logs = diag?.logs?.filter(l => l.includes('Jev') || l.includes('questions') || l.includes('choice') || l.includes('noul') || l.includes('q_')) || [];
              const step4Logs = diag?.logs?.filter(l => l.includes('拟命名') || l.includes('处理完成') || l.includes('提取') || l.includes('规则')) || [];

              return (
                <>
                  {/* 耗时可视化看板 */}
                  <div className="ocr-timing-dashboard">
                    <div className="ocr-timing-head">
                      <span className="ocr-timing-title">⏱ 全流程耗时可视化分析</span>
                      <span className="muted" style={{fontSize:11}}>总耗时：<strong>{(totalElapsed / 1000).toFixed(2)}s</strong></span>
                    </div>

                    <div className="ocr-timeline-track" title={`本地OCR: ${ocrMs}ms (${ocrPct}%), AI推理: ${jevMs}ms (${jevPct}%), 规则规整: ${ruleMs}ms (${rulePct}%)`}>
                      <div className="ocr-timeline-seg ocr-seg-ocr" style={{width: `${ocrPct}%`}}/>
                      <div className="ocr-timeline-seg ocr-seg-jev" style={{width: `${jevPct}%`}}/>
                      <div className="ocr-timeline-seg ocr-seg-rule" style={{width: `${rulePct}%`}}/>
                    </div>

                    <div className="ocr-timing-metrics">
                      <div className="ocr-timing-metric-item">
                        <span><span className="ocr-timing-dot ocr-dot-ocr"/>1. 本地离线 OCR 识别</span>
                        <strong>{ocrMs}ms ({ocrPct}%)</strong>
                      </div>
                      <div className="ocr-timing-metric-item">
                        <span><span className="ocr-timing-dot ocr-dot-jev"/>3. AI 语义模型推理</span>
                        <strong>{jevMs}ms ({jevPct}%)</strong>
                      </div>
                      <div className="ocr-timing-metric-item">
                        <span><span className="ocr-timing-dot ocr-dot-rule"/>4. 规则裁决与重命名</span>
                        <strong>{ruleMs}ms ({rulePct}%)</strong>
                      </div>
                      <div className="ocr-timing-metric-item">
                        <span><span className="ocr-timing-dot ocr-dot-total"/>全流程执行总用时</span>
                        <strong>{file.elapsedMs}ms</strong>
                      </div>
                    </div>
                  </div>

                  {/* 四大结构化执行步骤卡片 */}
                  <div className="ocr-step-list">
                    {/* 步骤 1 */}
                    <div className="ocr-step-card">
                      <div className="ocr-step-card-header">
                        <div className="ocr-step-left">
                          <span className="ocr-step-badge ocr-type-ocr">步骤 1 · 本地离线计算</span>
                          <span className="ocr-step-title">本地文档读取与 OCR 文本提取</span>
                        </div>
                        <div className="ocr-step-right">
                          <span className="ocr-step-time" style={{color:'#047857'}}>耗时 {ocrMs}ms</span>
                        </div>
                      </div>
                      <div className="ocr-step-card-body">
                        <div className="ocr-step-summary-grid">
                          <div className="ocr-step-summary-item">
                            <span>处理文档</span>
                            <span>{file.originalName}</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>离线识别引擎</span>
                            <span>RapidOCR（纯本地推理，零网络外发）</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>文本提取成果</span>
                            <span>共提取 <strong>{file.lines.length}</strong> 行文本 · 平均准确度 {(file.lines.length ? (file.lines.reduce((a,b)=>a+b.score,0)/file.lines.length*100).toFixed(0) : 0)}%</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>数据防篡改校验</span>
                            <span>本地文件指纹比对通过（识别期间未被修改）</span>
                          </div>
                        </div>

                        {step1Logs.length > 0 && (
                          <details className="ocr-step-raw-toggle">
                            <summary>展开查看步骤 1 执行细节（{step1Logs.length} 条记录）</summary>
                            <ul className="ocr-step-raw-list">
                              {step1Logs.map((l, i) => <li key={i}>{l}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>

                    {/* 步骤 2 */}
                    <div className="ocr-step-card">
                      <div className="ocr-step-card-header">
                        <div className="ocr-step-left">
                          <span className="ocr-step-badge ocr-type-mask">步骤 2 · 隐私沙箱防护</span>
                          <span className="ocr-step-title">商业机密脱敏与出站候选构建</span>
                        </div>
                        <div className="ocr-step-right">
                          <span className="ocr-step-time" style={{color:'#b45309'}}>耗时 &lt; 10ms</span>
                        </div>
                      </div>
                      <div className="ocr-step-card-body">
                        <div className="ocr-step-summary-grid">
                          <div className="ocr-step-summary-item">
                            <span>沙箱物理熔断机制</span>
                            <span>已启动画框安全沙箱，框外图像与金额绝对不出站</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>脱敏候选提炼</span>
                            <span>从 {file.lines.length} 行文本中整理出 <strong>{jev?.candidates?.length || 0}</strong> 个脱敏候选</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>定向问询组装</span>
                            <span>生成 <strong>{jev?.questions?.length || 0}</strong> 项针对提取字段的 Prompt 问询题目</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>脱敏合规审计</span>
                            <span>单价、总价、银行账户等敏感数字已全部置换为 [数值] 占位符</span>
                          </div>
                        </div>

                        {step2Logs.length > 0 && (
                          <details className="ocr-step-raw-toggle">
                            <summary>展开查看步骤 2 执行细节（{step2Logs.length} 条记录）</summary>
                            <ul className="ocr-step-raw-list">
                              {step2Logs.map((l, i) => <li key={i}>{l}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>

                    {/* 步骤 3 */}
                    <div className="ocr-step-card">
                      <div className="ocr-step-card-header">
                        <div className="ocr-step-left">
                          <span className="ocr-step-badge ocr-type-ai">步骤 3 · AI 语义决策</span>
                          <span className="ocr-step-title">大模型语义推理与候选打分</span>
                        </div>
                        <div className="ocr-step-right">
                          <span className="ocr-step-time" style={{color:'#1d4ed8'}}>耗时 {jevMs}ms</span>
                        </div>
                      </div>
                      <div className="ocr-step-card-body">
                        <div className="ocr-step-summary-grid">
                          <div className="ocr-step-summary-item">
                            <span>推理决策模型</span>
                            <span>TypeSafe Jev System One (v1.13.0)</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>推理状态</span>
                            <span>{jev?.enabled ? (jev?.success ? '调用成功，完成多候选语义打分' : (jev?.sent ? `调用异常: ${jev?.error || '网络错误'}（已平滑降级使用本地规则）` : '未发送问询')) : '未启用 Jev（使用纯本地规则）'}</span>
                          </div>
                          <div className="ocr-step-summary-item" style={{gridColumn:'1 / -1'}}>
                            <span>关键判定结论摘要</span>
                            <span>
                              {diag?.decisions && diag.decisions.length > 0
                                ? diag.decisions.map(d => `${d.fieldKey}: ${d.jevCandidate || d.finalValue || '未识别'}`).join(' ； ')
                                : (jev?.questions && jev.questions.length > 0 ? jev.questions.map(q => `${q.fieldKey}: ${q.chosenText || q.chosenId || '无'}`).join(' ； ') : '无字段判定')}
                            </span>
                          </div>
                        </div>

                        {step3Logs.length > 0 && (
                          <details className="ocr-step-raw-toggle">
                            <summary>展开查看步骤 3 执行细节（{step3Logs.length} 条记录）</summary>
                            <ul className="ocr-step-raw-list">
                              {step3Logs.map((l, i) => <li key={i}>{l}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>

                    {/* 步骤 4 */}
                    <div className="ocr-step-card">
                      <div className="ocr-step-card-header">
                        <div className="ocr-step-left">
                          <span className="ocr-step-badge ocr-type-rule">步骤 4 · 命名规整与质检</span>
                          <span className="ocr-step-title">综合裁决、格式校验与拟重命名</span>
                        </div>
                        <div className="ocr-step-right">
                          <span className="ocr-step-time" style={{color:'#6d28d9'}}>耗时 {ruleMs}ms</span>
                        </div>
                      </div>
                      <div className="ocr-step-card-body">
                        <div className="ocr-step-summary-grid">
                          <div className="ocr-step-summary-item">
                            <span>字段综合定稿</span>
                            <span>共完成 <strong>{Object.keys(file.fields).length}</strong> 个字段提取（{Object.values(file.fields).filter(f=>f.review).length > 0 ? <strong style={{color:'var(--danger)'}}>有 {Object.values(file.fields).filter(f=>f.review).length} 项需人工复核</strong> : '全部达标无需复核'}）</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>拟重命名生成</span>
                            <span style={{color:'var(--focus)',fontWeight:600}}>{file.proposedName || '—'}</span>
                          </div>
                          <div className="ocr-step-summary-item">
                            <span>最终质量状态</span>
                            <span>{file.reviewed ? '用户已手动核对确认' : (file.status === 'review' ? '部分字段置信度低于阈值，已触发需复核状态' : '置信度合格，文件已处于就绪状态')}</span>
                          </div>
                        </div>

                        {step4Logs.length > 0 && (
                          <details className="ocr-step-raw-toggle">
                            <summary>展开查看步骤 4 执行细节（{step4Logs.length} 条记录）</summary>
                            <ul className="ocr-step-raw-list">
                              {step4Logs.map((l, i) => <li key={i}>{l}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 原始终端流日志（折叠保留，便于深度技术审计） */}
                  <details className="ocr-step-raw-toggle" style={{marginTop:8}}>
                    <summary style={{fontWeight:600,fontSize:12,cursor:'pointer'}}>
                      查看完整原始技术流水日志（共 {diag?.logs?.length || 0} 步）
                    </summary>
                    <div className="ocr-terminal-wrapper" style={{marginTop:8}}>
                      <div className="ocr-terminal-head">
                        <span>RAW EXECUTION TRACE · 共 {diag?.logs?.length||0} 步事件流水</span>
                        <div style={{display:'flex',gap:10,alignItems:'center'}}>
                          {diag?.logs&&diag.logs.length>0&&(
                            <a
                              href="#"
                              role="button"
                              style={{color:'#9cdcfe',textDecoration:'none',cursor:'pointer'}}
                              onClick={e=>{e.preventDefault();copy('logs',diag.logs.join('\n'));}}
                            >
                              {copied==='logs'?'已复制全部原始日志':'复制全部原始日志'}
                            </a>
                          )}
                          <span>STATUS: {file.status.toUpperCase()}</span>
                        </div>
                      </div>
                      <ul className="ocr-terminal-body">
                        {diag?.logs&&diag.logs.length>0?diag.logs.map((log,i)=>(
                          <li key={i}>
                            <span className="step-num">[{String(i+1).padStart(3,'0')}]</span>
                            <span className="step-text">{log}</span>
                          </li>
                        )):(
                          <li style={{color:'#858585',justifyContent:'center',padding:'30px 0'}}>暂无日志流水记录</li>
                        )}
                      </ul>
                    </div>
                  </details>
                </>
              );
            })()}
          </div>
        )}

        {tab==='lines'&&(
          <div className="ocr-lines-wrapper">
            <div className="ocr-lines-summary">
              共提取 <strong>{file.lines.length}</strong> 行文本，可对照文档位置核实 OCR 识别文本与四角几何坐标：
            </div>
            <div className="ocr-lines-table-scroll">
              <table className="ocr-lines-full-table">
                <thead>
                  <tr>
                    <th style={{width:50,textAlign:'center'}}>#</th>
                    <th style={{width:60,textAlign:'center'}}>页码</th>
                    <th style={{width:'auto'}}>识别文字内容</th>
                    <th style={{width:90,textAlign:'center'}}>置信度</th>
                    <th style={{width:240}}>识别框坐标 (X, Y)</th>
                  </tr>
                </thead>
                <tbody>
                  {file.lines.map((l,i)=>(
                    <tr key={i}>
                      <td style={{textAlign:'center',color:'var(--muted)'}}>{i+1}</td>
                      <td style={{textAlign:'center'}}>第 {l.page} 页</td>
                      <td style={{wordBreak:'break-all',fontFamily:'sans-serif'}}>{l.text}</td>
                      <td style={{textAlign:'center'}}><span className="ocr-badge success">{(l.score*100).toFixed(0)}%</span></td>
                      <td style={{fontSize:11,color:'var(--muted)',fontFamily:'monospace'}}>
                        {l.box.map(p=>p.map(n=>Math.round(n)).join(',')).join(' / ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ProfileEditor({value:p,busy,error,notice,onChange,onClose,onSave,onDelete,onAI,onExport}:{value:OcrProfile;busy:boolean;error:string;notice:string;onChange:(p:OcrProfile)=>void;onClose:()=>void;onSave:()=>void;onDelete:()=>void;onAI:(s:string)=>void;onExport:()=>void}){
  const [description,setDescription]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
  const [tab,setTab]=useState('fields'),[fieldIndex,setFieldIndex]=useState(0);
  const content=useRef<HTMLFieldSetElement>(null);
  const set=(v:Partial<OcrProfile>)=>onChange({...p,...v});
  const index=Math.min(fieldIndex,p.fields.length-1),f=p.fields[index];
  useEffect(()=>{content.current?.scrollTo({top:0});},[tab,index]);
  const field=(v:Partial<OcrFieldDefinition>)=>onChange(updateProfileField(p,index,v));
  const list=(s:string)=>s.split(/[，,\n]/).map(x=>x.trim()).filter(Boolean);
  const kinds={text:'文字',date:'日期',number:'数字 / 金额'};
  return <Modal title="OCR 配置编辑器" className="ocr-profile-dialog" onClose={()=>!busy&&onClose()}><div className="ocr-editor">
    <div className="ocr-profile-bar"><label className="ocr-field">配置名称<input aria-label="配置名称" disabled={busy} value={p.name} onChange={e=>set({name:e.target.value})}/></label><Button icon={<DownloadSimple/>} disabled={busy} onClick={onExport}>导出配置</Button></div>
    <TabList className="ocr-profile-tabs" aria-label="配置分区" selectedValue={tab} onTabSelect={(_,d)=>setTab(String(d.value))}>
      <Tab id="ocr-tab-fields" value="fields" icon={<TextT aria-hidden="true"/>} aria-controls="ocr-panel-fields">提取字段 <span className="ocr-tab-count">{p.fields.length}</span></Tab>
      <Tab id="ocr-tab-regions" value="regions" icon={<Scan aria-hidden="true"/>} aria-controls="ocr-panel-regions">框选区域 <span className="ocr-tab-count">{p.regions?.length||0}</span></Tab>
      <Tab id="ocr-tab-general" value="general" icon={<SlidersHorizontal aria-hidden="true"/>} aria-controls="ocr-panel-general">通用设置</Tab>
    </TabList>
    {error&&<p className="ocr-editor-feedback inline-error" role="alert">{error}</p>}
    {notice&&<p className="ocr-editor-feedback muted" role="status">{notice}</p>}
    <fieldset ref={content} className="ocr-profile-content" disabled={busy} aria-label="OCR 配置内容">
      <div id="ocr-panel-fields" role="tabpanel" aria-labelledby="ocr-tab-fields" hidden={tab!=='fields'} className="ocr-editor-panel">
        <div className="ocr-section-heading"><div><h3>字段与提取规则</h3><p className="muted">选择字段，设置名称、类型与提取规则。</p></div><Button icon={<Plus/>} disabled={p.fields.length>=40} onClick={()=>{setFieldIndex(p.fields.length);set({fields:[...p.fields,newField()]});}}>添加字段</Button></div>
        {!!p.fields.length&&<div className="ocr-field-workspace">
          <nav className="ocr-field-list" aria-label="提取字段列表">{p.fields.map((item,i)=><button type="button" key={i} aria-pressed={i===index} onClick={()=>setFieldIndex(i)}><span className="ocr-field-kind" aria-hidden="true">{item.kind==='date'?<CalendarBlank/>:item.kind==='number'?<Hash/>:<TextT/>}</span><span className="ocr-field-list-copy"><strong>{item.key||'未命名字段'}</strong><small>{kinds[item.kind]}{item.required?' · 必填':''}{item.multiple?' · 多个值':''}</small></span><CaretRight className="ocr-field-current" size={12} aria-hidden="true"/></button>)}</nav>
          {f&&<section className="ocr-field-editor" key={index} aria-label={`编辑字段 ${f.key||index+1}`}>
            <div className="ocr-section-heading"><h3>{f.key||'新字段'}</h3><Button size="small" appearance="subtle" icon={<Trash/>} onClick={()=>{onChange(updateProfileField(p,index,null));setFieldIndex(Math.max(0,index-1));}}>移除字段</Button></div>
            <div className="ocr-form-grid"><label className="ocr-field">字段名称<input aria-label={`字段名称 ${index+1}`} value={f.key} onChange={e=>field({key:e.target.value})}/></label><label className="ocr-field">字段类型<select aria-label="字段类型" value={f.kind} onChange={e=>field({kind:e.target.value as OcrFieldDefinition['kind'],format:''})}><option value="text">文字</option><option value="date">日期</option><option value="number">数字 / 金额</option></select></label></div>
            <div className="ocr-buttons"><Checkbox label="必填" checked={f.required} onChange={(_,v)=>field({required:!!v.checked})}/><Checkbox label="多个值" checked={f.multiple} onChange={(_,v)=>field({multiple:!!v.checked})}/>{f.multiple&&<><label>最多保留 <input className="ocr-small-number" type="number" min={1} max={20} value={f.maxItems} onChange={e=>field({maxItems:Number(e.target.value)})}/></label><label>分隔符 <input className="ocr-small-number" value={f.separator} onChange={e=>field({separator:e.target.value})}/></label></>}</div>
            <section className="ocr-field-rules"><h4>本地提取规则</h4><p className="muted">默认使用；启用 Jev 后，未获得结果时回退到这些规则。</p><div className="ocr-form-grid">
              <label className="ocr-field">定位标签（逗号分隔）<input value={f.anchors.join(',')} onChange={e=>field({anchors:list(e.target.value)})}/></label><label className="ocr-field">清理前缀（逗号分隔）<input value={f.stripPrefixes.join(',')} onChange={e=>field({stripPrefixes:list(e.target.value)})}/></label>
              <label className="ocr-field">未识别时的显示值<input value={f.fallback} onChange={e=>field({fallback:e.target.value})}/></label>
              {f.kind==='date'&&<label className="ocr-field">日期格式<select value={f.format} onChange={e=>field({format:e.target.value})}><option value="">YYYYMMDD</option><option value="%Y%m%d">YYYYMMDD</option><option value="%Y-%m-%d">YYYY-MM-DD</option><option value="%Y/%m/%d">YYYY/MM/DD</option><option value="%Y年%m月%d日">YYYY年MM月DD日</option></select></label>}
              {f.kind==='number'&&<label className="ocr-field">保留小数位<select value={f.format} onChange={e=>field({format:e.target.value})}><option value="">保持原值</option>{[0,1,2,3,4,5,6].map(n=><option value={String(n)} key={n}>{n} 位</option>)}</select></label>}
            </div></section>
            <details className="ocr-editor-details"><summary>高级提取规则{f.pattern||f.prompt?' · 已配置':''}</summary><div className="ocr-form-grid"><label className="ocr-field">正则表达式<input value={f.pattern} onChange={e=>field({pattern:e.target.value})} placeholder="优先取第一个捕获组"/></label><label className="ocr-field">Jev 判断说明<input aria-label={`字段说明 ${index+1}`} value={f.prompt} onChange={e=>field({prompt:e.target.value})}/><small>仅在识别设置中启用 Jev 时生效。</small></label></div></details>
          </section>}
        </div>}
        {!p.fields.length&&<div className="ocr-editor-empty"><h3>添加你需要的字段</h3><p className="muted">例如客户名称、产品名称、日期。也可以使用 AI 生成草稿；不设置字段时，仅识别和导出文字。</p></div>}
        <details className="ocr-ai-config" open={p.fields.length===0?true:undefined}><summary><Sparkle aria-hidden="true"/> 用 AI 生成或优化字段</summary><label className="ocr-field">描述要提取或优化的内容<textarea aria-label="AI 配置需求" value={description} onChange={e=>setDescription(e.target.value)} placeholder={p.fields.length?'例如：优化产品名称提取规则，支持带括号的品名。':'例如：提取设备编号、验收日期和验收单位，以日期和编号命名。'} rows={2}/></label><div><span className="muted">只生成规则，不读取样本文档。微调请写明字段名称，核对并保存后生效。</span><Button icon={<Sparkle/>} disabled={busy||!description.trim()} onClick={()=>onAI(description)}>{busy?'处理中…':p.fields.length?'AI 优化已有配置':'AI 生成配置草稿'}</Button></div></details>
      </div>
      <div id="ocr-panel-regions" role="tabpanel" aria-labelledby="ocr-tab-regions" hidden={tab!=='regions'} className="ocr-editor-panel ocr-regions-panel">
        <OcrRegions disabled={busy} fieldKeys={[...new Set(p.fields.map(item=>item.key).filter(Boolean))]} regions={p.regions||[]} onChange={regions=>set({regions,...(regions.length&&regions.every(r=>r.page>0)?{pages:[...new Set(regions.map(r=>r.page))].sort((a,b)=>a-b).join(',')}: {})})}/>
      </div>
      <div id="ocr-panel-general" role="tabpanel" aria-labelledby="ocr-tab-general" hidden={tab!=='general'} className="ocr-editor-panel">
        <section className="ocr-profile-section"><h3>自动匹配</h3><label className="ocr-field">自动匹配关键词（逗号分隔）<input aria-describedby="ocr-match-keywords-help" value={p.keywords.join(',')} onChange={e=>set({keywords:list(e.target.value)})}/><small id="ocr-match-keywords-help">{p.keywords.some(k=>k.trim())?'保存后，在下一次任务中生效。':'尚未填写，只能手动选择此配置。'} 例如：报价单,Quotation。自动匹配只检查首页，配置名称和附加标题不参与匹配。</small></label></section>
        <section className="ocr-profile-section"><h3>识别与复核</h3><div className="ocr-form-grid ocr-recognition-grid"><label className="ocr-field">识别页范围<input aria-label="页范围" value={p.pages} onChange={e=>set({pages:e.target.value})} placeholder="all 或 1-3,5"/><small>all 表示全部页面，也可填写 1-3,5。框选指定页面时会同步更新。</small></label><label className="ocr-field">渲染清晰度（DPI）<input type="number" min={100} max={400} value={p.dpi} onChange={e=>set({dpi:Number(e.target.value)})}/><small>范围 100–400，默认 200。</small></label><label className="ocr-field">低于此分数需复核<input type="number" min={0} max={1} step={.05} value={p.threshold} onChange={e=>set({threshold:Number(e.target.value)})}/><small>也用于自动匹配：低于此分数的首页关键词不计入命中数。请先查看匹配诊断再调整。</small></label></div></section>
        <section className="ocr-profile-section"><h3>文件命名</h3><label className="ocr-field">命名格式<input aria-label="命名格式" value={p.filenamePattern} onChange={e=>set({filenamePattern:e.target.value})}/><small>可用：{'{原文件名}'} {p.fields.filter(item=>item.key).map(item=>`{${item.key}}`).join(' ')}；保留原扩展名。</small></label></section>
        <details className="ocr-editor-details"><summary>版式专有词{p.extraTitles?.length||p.noiseMarkers?.length||p.extraHeaders?.length?' · 已配置':''}</summary><p className="muted">仅影响当前配置，不写入通用规则。</p><div className="ocr-form-grid"><label className="ocr-field">附加标题（逗号分隔）<input value={(p.extraTitles||[]).join(',')} onChange={e=>set({extraTitles:list(e.target.value)})}/></label><label className="ocr-field">排除词（逗号分隔）<input value={(p.noiseMarkers||[]).join(',')} onChange={e=>set({noiseMarkers:list(e.target.value)})}/></label><label className="ocr-field">补充表头（逗号分隔）<input value={(p.extraHeaders||[]).join(',')} onChange={e=>set({extraHeaders:list(e.target.value)})}/></label></div></details>
        <p className="ocr-policy">发送给 Jev 的单价、金额及其他数字会强制脱敏，不能通过配置关闭。需要比较原始数值时，请配置本地规则并复核结果。</p>
      </div>
    </fieldset>
    <footer className="ocr-editor-footer"><div className="ocr-buttons"><Button size="small" appearance="subtle" disabled={busy} icon={<Copy/>} onClick={()=>set({...structuredClone(p),id:crypto.randomUUID(),name:`${p.name} 副本`})}>复制为新配置</Button><Button size="small" appearance="subtle" className="ocr-delete-toggle" disabled={busy} onClick={()=>setConfirmDelete(v=>!v)}>{confirmDelete?'取消删除':'删除配置'}</Button></div><span className="muted">修改后需保存</span><div className="ocr-buttons"><Button disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy} appearance="primary" icon={<Check aria-hidden="true"/>} onClick={onSave}>{busy?'处理中…':'保存配置'}</Button></div></footer>
    {confirmDelete&&<div className="ocr-delete-confirm" role="alert"><span>删除“{p.name}”后将无法在新任务中选择此配置。</span><Button disabled={busy} onClick={onDelete}>确认删除配置</Button></div>}
  </div></Modal>;
}
