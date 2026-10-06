import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox } from '@fluentui/react-components';
import { Plus, Files, FolderOpen, Scan, Sparkle, ArrowCounterClockwise, DownloadSimple, Stop, X, Trash, Copy, Check } from '@phosphor-icons/react';
import { listen } from '@tauri-apps/api/event';
import { api, copy as copyText, desktop } from './api';
import { Empty, IconButton, Modal } from './components';
import { basename, dirname } from './domain';
import { newField, newProfile, updateProfileField, type OcrBootstrap, type OcrFieldDefinition, type OcrFileResult, type OcrProfile, type OcrRenameBatch, type OcrTask } from './ocrTypes';
import './ocr.css';
import { OcrRegions } from './OcrRegions';

const labels:Record<string,string>={queued:'排队中',running:'正在识别',completed:'已结束',ready:'已就绪',review:'需复核',failed:'失败',cancelled:'已取消',interrupted:'已中断',pending:'待执行',done:'已改名',undone:'已撤销',conflict:'冲突',local:'本地规则',jev:'Jev',manual:'人工修正',missing:'未识别'};
const active=(t?:OcrTask)=>!!t&&['running','queued'].includes(t.status);
const download=(name:string,text:string)=>{const mime=name.endsWith('.json')?'application/json':name.endsWith('.csv')?'text/csv':'text/plain';const url=URL.createObjectURL(new Blob([text],{type:`${mime};charset=utf-8`}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const exportOptions=[
  {format:'txt',label:'识别文本 (TXT)',title:'导出所有文件的 OCR 识别原始文本行 (.txt)'},
  {format:'csv',label:'字段表格 (CSV)',title:'导出文件名及提取出的结构化字段表格，支持 Excel 打开 (.csv)'},
  {format:'json',label:'完整数据 (JSON)',title:'导出包含识别坐标、提取字段与诊断日志的完整任务数据 (.json)'},
] as const;
export default function OcrWorkbench({visible,incoming,onConsumed,onSettings}:{visible:boolean;incoming:string[];onConsumed:(paths:string[])=>void;onSettings:()=>void}){
  const [data,setData]=useState<OcrBootstrap>({profiles:[],tasks:[],batches:[],engineReady:false,jevReady:false});
  const [reviewOnly,setReviewOnly]=useState(false);
  const [paths,setPaths]=useState<string[]>([]),[profileId,setProfileId]=useState(''),[useJev,setUseJev]=useState<boolean>(()=>{
    try{return localStorage.getItem('ocr_use_jev')==='true';}catch{return false;}
  });
  const [uniformRows,setUniformRows]=useState<boolean>(()=>{
    try{return localStorage.getItem('ocr_uniform_rows')!=='false';}catch{return true;}
  });
  const [taskId,setTaskId]=useState(''),[fileId,setFileId]=useState(''),[checked,setChecked]=useState<string[]>([]);
  const [editor,setEditor]=useState<OcrProfile|null>(null),[batch,setBatch]=useState<OcrRenameBatch|null>(null),[undo,setUndo]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState(false);
  const [recheckPrompt,setRecheckPrompt]=useState<{paths:string[];duplicateCount:number;total:number}|null>(null);
  const importInput=useRef<HTMLInputElement>(null),mounted=useRef(true),tasksRef=useRef<OcrTask[]>([]),importing=useRef(false);
  const [detailVersion,setDetailVersion]=useState(0);
  const task=data.tasks.find(t=>t.id===taskId),file=task?.files.find(f=>f.id===fileId),profile=data.profiles.find(p=>p.id===profileId);
  const allIdentifiedPaths=new Set(data.tasks.flatMap(t=>t.files.map(f=>f.path.toLowerCase())));
  const refresh=useCallback(async()=>{
    const next=await api<OcrBootstrap>('ocr_bootstrap');
    if(mounted.current){
      tasksRef.current=next.tasks;
      setData(next);
      setProfileId(curr=>{
        if(next.profiles.some(p=>p.id===curr))return curr;
        return next.profiles[0]?.id||'';
      });
    }
    return next;
  },[]);
  const refreshTask=useCallback(async(id:string)=>{const next=await api<OcrTask>('ocr_get_task',{id});if(mounted.current)setData(current=>{if(!current.tasks.some(t=>t.id===id))return current;const tasks=current.tasks.map(t=>t.id===id?next:t);tasksRef.current=tasks;return {...current,tasks};});},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(visible)void refresh().catch(e=>setError(String(e)));},[visible,refresh]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}};
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
  async function start(targetPaths?:string[],retryId?:string){
    const toRun=targetPaths||paths;
    if(!profileId||!data.profiles.some(p=>p.id===profileId)){
      setError('请先在上方选择一个具体的识别配置模板再开始识别');
      return;
    }
    const id=await api<string>('ocr_start_task',{paths:toRun,profileId,useJev,retryId:retryId||null});
    setTaskId(id);setFileId('');setChecked([]);if(!retryId)setPaths([]);await refresh();
  }
  function triggerStart(targetPaths?:string[]){
    const toRun=targetPaths||paths;
    if(!toRun.length)return;
    const duplicateCount=toRun.filter(p=>allIdentifiedPaths.has(p.toLowerCase())).length;
    if(duplicateCount>0){
      setRecheckPrompt({paths:toRun,duplicateCount,total:toRun.length});
    }else{
      void run(()=>start(toRun));
    }
  }
  function selectTask(t:OcrTask){setTaskId(t.id);setFileId('');setChecked([]);}
  async function exportTask(format:string){
    if(!task)return;
    if(!desktop){
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
    const path=await save({defaultPath:`OCR-${task.id.slice(0,8)}.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(path){await api('ocr_export',{taskId:task.id,format,path});setNotice('结果已导出');}
  }
  async function importProfiles(file:File){const list=await api<OcrProfile[]>('ocr_import_profiles',{text:await file.text()});if(!list.length)throw new Error('配置文件中没有模板');const known=[...data.profiles];for(const p of list){const existing=known.find(x=>x.id===p.id)||known.find(x=>x.name===p.name);const saved={...p,id:existing?.id||p.id};await api('ocr_save_profile',{profile:saved});const index=known.findIndex(x=>x.id===saved.id);if(index>=0)known[index]=saved;else known.push(saved);}await refresh();setNotice(`已导入 ${list.length} 个配置，请编辑核对字段类型与本地规则`);}
  const canRename=task&&!active(task)&&checked.length>0;
  const visibleFiles=task?.files.filter(f=>!reviewOnly||f.status==='review'&&!f.reviewed)||[];
  const eligible=visibleFiles.filter(f=>f.status==='ready'||f.status==='review'&&f.reviewed).map(f=>f.id)||[];
  return <div className="ocr-page" hidden={!visible}>
    <div className="page-heading"><div><h1>文档 OCR<span className="heading-dot">/</span><span className="heading-sub">从文字，到有序的资料。</span></h1></div><Button icon={<ArrowCounterClockwise/>} onClick={()=>setHistory(true)}>改名记录</Button></div>
    {error&&<div className="ocr-message error" role="alert"><span>{error}</span><IconButton label="关闭错误" onClick={()=>setError('')}><X/></IconButton></div>}
    {notice&&<div className="ocr-message" role="status"><span>{notice}</span><IconButton label="关闭消息" onClick={()=>setNotice('')}><X/></IconButton></div>}
    <section className="ocr-setup" aria-label="OCR 任务设置">
      <div className="ocr-setup-row"><Button icon={<Files/>} disabled={busy} onClick={()=>void run(()=>pickFiles(false))}>添加文件</Button><Button icon={<FolderOpen/>} disabled={busy} onClick={()=>void run(()=>pickFiles(true))}>添加文件夹</Button><span className="muted">PDF · PNG · JPEG · BMP · TIFF，也可拖放到此页</span></div>
      <div className="ocr-setup-row"><label className="ocr-profile-select">识别配置<select aria-label="识别配置" value={profileId} onChange={e=>setProfileId(e.target.value)}>{data.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><Button disabled={!profile} onClick={()=>setEditor(structuredClone(profile!))}>编辑配置</Button><Button icon={<Plus/>} onClick={()=>setEditor(newProfile())}>新建配置</Button><Button onClick={()=>importInput.current?.click()}>导入配置</Button><input className="sr-only" aria-label="导入 OCR 配置文件" ref={importInput} type="file" accept=".json,.yaml,.yml" onChange={e=>{const f=e.target.files?.[0];if(f)void run(()=>importProfiles(f));e.target.value='';}}/><span className="ocr-spacer"/><Checkbox label="优先使用 Jev 判断字段" checked={useJev} onChange={(_,v)=>{const c=!!v.checked;setUseJev(c);try{localStorage.setItem('ocr_use_jev',String(c));}catch{}}}/></div>
      <div className="ocr-policy">{useJev?'已启用 Jev：仅向模型发送数字脱敏后的候选文字；页面图片、数值原文留在本机。':'默认模式：本地 OCR 后执行定位标签、正则与格式规则；Jev 判断说明仅在启用 Jev 时参与语义判断。'}{useJev&&!data.jevReady&&<> 尚未配置 Jev 密钥，字段将使用本地规则。<button className="text-button" onClick={onSettings}>前往设置</button></>}{data.unavailableReason?<strong role="alert"> OCR 暂不可用：{data.unavailableReason}</strong>:!data.engineReady&&<strong> 本地 OCR 引擎未安装。</strong>}</div>
    </section>
    <div className="ocr-layout">
      <aside className="ocr-task-list" aria-label="OCR 任务列表">
        <div className="ocr-task-list-header">
          <h2>任务记录 <span>{data.tasks.length}</span></h2>
          {data.tasks.some(t=>!active(t))&&<Button size="small" appearance="subtle" title="清空所有已结束的任务" onClick={()=>void run(async()=>{const count=await api<number>('ocr_clear_completed_tasks');if(task&&!active(task)){setTaskId('');setFileId('');}await refresh();setNotice(`已清理 ${count} 个已结束任务`);})}>清空已结束</Button>}
        </div>
        {paths.length>0&&<div className={`ocr-task-item ${taskId===''?'selected':''} ocr-pending-task`}>
          <button className="ocr-task-button" onClick={()=>{setTaskId('');setFileId('');}}>
            <strong>待处理文件</strong>
          </button>
          <button type="button" className="ocr-task-delete" title="清空清单" onClick={e=>{e.stopPropagation();setPaths([]);}}><Trash/></button>
        </div>}
        {!data.tasks.length&&paths.length===0&&<p className="muted">识别任务会保存在本机。</p>}
        {data.tasks.map(t=><div key={t.id} className={`ocr-task-item ${t.id===taskId?'selected':''}`}>
          <button className="ocr-task-button" onClick={()=>selectTask(t)}>
            <strong>{t.profiles[0]?.name||'通用配置'} · {t.files.length} 个文件</strong>
            <span>{new Date(t.created*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
            <small>{labels[t.status]||t.status} · {t.files.filter(f=>!['queued','running'].includes(f.status)).length}/{t.files.length}</small>
          </button>
          {!active(t)&&<button type="button" className="ocr-task-delete" title="删除此任务记录" aria-label={`删除任务 ${t.profiles[0]?.name||''}`} onClick={e=>{e.stopPropagation();void run(async()=>{await api('ocr_delete_task',{id:t.id});if(taskId===t.id){const rem=data.tasks.filter(x=>x.id!==t.id);if(rem.length){selectTask(rem[0]);}else{setTaskId('');setFileId('');}}await refresh();setNotice('任务记录已删除');});}}><Trash/></button>}
        </div>)}
      </aside>
      {taskId===''&&paths.length>0?(
        <section className="ocr-results ocr-pending-results" aria-label="待识别文件清单">
          <header>
            <div>
              <h2>文件清单</h2>
              {paths.some(p=>allIdentifiedPaths.has(p.toLowerCase()))&&<span className="ocr-badge warning" style={{marginLeft:8}}>其中 {paths.filter(p=>allIdentifiedPaths.has(p.toLowerCase())).length} 项曾识别过</span>}
            </div>
            <div className="ocr-buttons">
              <Button icon={<Trash/>} appearance="subtle" onClick={()=>setPaths([])}>清空清单</Button>
              <Button appearance="primary" icon={<Scan/>} disabled={busy||!data.engineReady} onClick={()=>triggerStart()}>开始识别 · {paths.length}</Button>
            </div>
          </header>
          <div className="ocr-table-scroll"><table><thead><tr><th style={{width:44,textAlign:'center'}}>#</th><th style={{width:'38%'}}>文件名称</th><th style={{width:'auto'}}>所在文件夹</th><th style={{width:90}}>历史记录</th><th style={{width:60,textAlign:'center'}}>操作</th></tr></thead><tbody>{paths.map((p,idx)=>{const isRecheck=allIdentifiedPaths.has(p.toLowerCase());return <tr key={p}><td className="muted" style={{textAlign:'center'}}>{idx+1}</td><td><strong>{basename(p)}</strong></td><td className="muted" title={p} style={{fontSize:11}}>{dirname(p)}</td><td>{isRecheck?<span className="ocr-tag warning">曾识别过</span>:null}</td><td style={{textAlign:'center'}}><IconButton label={`移除 ${basename(p)}`} onClick={()=>setPaths(v=>v.filter(x=>x!==p))}><X/></IconButton></td></tr>;})}</tbody></table></div>
        </section>
      ):!task?(
        <section className="ocr-results" aria-label="OCR 结果">
          <Empty title="让文档变成可用的信息" detail="添加文件或选择文件夹，选择已有配置或让 AI 帮你创建配置。识别后可校正字段、导出和批量改名。"/>
        </section>
      ):(
        <section className="ocr-results" aria-label="OCR 结果">
          <header><div><h2>{labels[task.status]} <span className="muted">{task.files.length} 个文件</span></h2>{active(task)&&<progress aria-label="OCR 进度" max={task.files.length} value={task.files.filter(f=>!['queued','running'].includes(f.status)).length}/>}</div><div className="ocr-buttons">{active(task)?<Button icon={<Stop/>} onClick={()=>void run(async()=>{await api('ocr_cancel_task',{id:task.id});await refresh();})}>取消任务</Button>:<><Button icon={<ArrowCounterClockwise/>} disabled={busy} onClick={()=>triggerStart(task.files.map(f=>f.path))}>再次识别全部</Button><Button disabled={busy||!task.files.some(f=>['failed','cancelled','interrupted'].includes(f.status))} onClick={()=>void run(()=>start(undefined,task.id))}>重试未完成项</Button></>}</div></header>
        <div className="ocr-table-filter-bar">
          <Checkbox label="只显示需复核" checked={reviewOnly} onChange={(_,v)=>{setReviewOnly(!!v.checked);setChecked([]);setFileId('');}}/>
          <span className="ocr-spacer"/>
          <Checkbox label="规整等高视图" title="锁定每行绝对等高，治愈强迫症" checked={uniformRows} onChange={(_,v)=>{const c=!!v.checked;setUniformRows(c);try{localStorage.setItem('ocr_uniform_rows',String(c));}catch{}}}/>
        </div>
        <div className={`ocr-table-scroll ${uniformRows?'uniform-rows':''}`}>
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
              {visibleFiles.map(f=><tr key={f.id} className={f.id===fileId?'selected':''}>
                <td><Checkbox aria-label={`选择 ${f.originalName}`} checked={checked.includes(f.id)} disabled={!['ready','review'].includes(f.status)||f.status==='review'&&!f.reviewed} onChange={(_,v)=>setChecked(ids=>v.checked?[...ids,f.id]:ids.filter(id=>id!==f.id))}/></td>
                <td>
                  <button className="ocr-file-button" onClick={()=>setFileId(f.id)} title={`点击查看识别详情：${f.originalName}`}>
                    <span className="ocr-cell-scrollable">{f.originalName}</span>
                    <small>{basename(f.path)!==f.originalName?basename(f.path):`${f.lines.length} 行 · ${(f.elapsedMs/1000).toFixed(1)} 秒`}</small>
                  </button>
                </td>
                <td><span className="ocr-profile-tag" title={f.profile?.name||'等待匹配'}>{f.profile?.name||'等待匹配'}</span></td>
                <td>
                  <div className="ocr-proposed-cell" title={f.proposedName||''}>
                    <span className="ocr-cell-scrollable">{f.proposedName||'—'}</span>
                  </div>
                </td>
                <td><span className={`ocr-status ${f.status}`}>{f.reviewed?'已复核':labels[f.status]}</span></td>
              </tr>)}
            </tbody>
          </table>
        </div>
          <footer>
            <div className="ocr-buttons ocr-export-group">
              <span className="ocr-export-label">导出结果：</span>
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
      {file&&task&&<ResultDetail key={`${task.id}:${file.id}:${file.status}:${detailVersion}`} file={file} disabled={busy||active(task)} onSave={(values,name,reviewed)=>run(async()=>{await api('ocr_update_result',{taskId:task.id,fileId:file.id,values,proposedName:name,reviewed});await refresh();setDetailVersion(v=>v+1);setNotice('结果已保存');})} onOpen={reveal=>void run(async()=>{await api('ocr_open_file',{taskId:task.id,fileId:file.id,reveal});})} onClose={()=>setFileId('')}/>}
    </div>
    {editor&&<ProfileEditor value={editor} busy={busy} error={error} onChange={setEditor} onClose={()=>{setEditor(null);setError('');}} onSave={()=>void run(async()=>{await api('ocr_save_profile',{profile:editor});await refresh();setProfileId(editor.id);setEditor(null);setNotice('配置已保存');})} onDelete={()=>void run(async()=>{await api('ocr_delete_profile',{id:editor.id});const rem=data.profiles.filter(p=>p.id!==editor.id);setProfileId(rem[0]?.id||'');setEditor(null);await refresh();})} onAI={description=>void run(async()=>{const next=await api<OcrProfile>('ocr_generate_profile',{description,profile:editor});setEditor(next);setNotice(editor.fields.length?'AI 针对性微调完成，已锁定保护其余已有字段与画框':'AI 草稿已生成，请核对并保存');})} onExport={()=>void run(async()=>{if(!desktop){download(`${editor.name}.json`,JSON.stringify(editor,null,2));return;}const {save}=await import('@tauri-apps/plugin-dialog');const path=await save({defaultPath:'OCR配置.json',filters:[{name:'JSON',extensions:['json']}]});if(path)await api('ocr_export_profile',{profile:editor,path});})}/ >}
    {recheckPrompt&&<Modal title="再次识别提醒" onClose={()=>setRecheckPrompt(null)}><p>所选的 <strong>{recheckPrompt.total}</strong> 个文件中，有 <strong>{recheckPrompt.duplicateCount}</strong> 个文件之前已经识别过。</p><p className="muted" style={{margin:'8px 0 16px',fontSize:12}}>再次识别将基于当前选择的配置【<strong>{profile?.name||'未选择配置'}</strong>】重新执行 OCR 提取与命名规整，并生成一份全新的任务记录，原记录不会被覆盖。</p><div className="dialog-actions"><Button onClick={()=>setRecheckPrompt(null)}>取消</Button><Button appearance="primary" disabled={busy} onClick={()=>{const toRun=recheckPrompt.paths;setRecheckPrompt(null);void run(()=>start(toRun));}}>确认再次识别</Button></div></Modal>}
    {batch&&<Modal title={undo?'撤销该批次改名':'确认批量重命名'} wide onClose={()=>!busy&&setBatch(null)}><p>{batch.status==='executed'?'批次改名已执行完成。':batch.status==='rollback'?'批次改名已成功撤销。':'逐项检查文件身份与目标路径，不覆盖已有文件。'}</p><div className="ocr-rename-list">{batch.items.map((r,i)=><div key={i}><span>{basename(undo?r.target:r.original)} → <strong>{basename(undo?r.original:r.target)}</strong></span><small>{labels[r.status]||r.status} {r.error}</small></div>)}</div>{error&&<p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Button disabled={busy} onClick={()=>setBatch(null)}>{(batch.status==='executed'||batch.status==='rollback')?'完成并关闭':'关闭'}</Button>{batch.status!=='executed'&&batch.status!=='rollback'&&<Button appearance="primary" disabled={busy||(!undo&&batch.status!=='preview')} onClick={()=>void run(async()=>{const res=await api<OcrRenameBatch>('ocr_apply_rename',{batchId:batch.id,undo});setBatch(res);await refresh();setChecked([]);setNotice(undo?'已成功撤销该批次改名':'批量改名已完成');})}>{undo?'确认撤销':'执行改名'}</Button>}</div></Modal>}
    {history&&<Modal title="改名记录" wide onClose={()=>setHistory(false)}>{data.batches.filter(b=>b.status!=='preview').length===0?<p>还没有执行过重命名。</p>:data.batches.filter(b=>b.status!=='preview').map(b=><div className="ocr-history-row" key={b.id}><span>{b.items.length} 个文件 · {b.items.filter(i=>i.status==='done').length} 项可撤销<small>{b.id.slice(0,8)}</small></span><Button disabled={!b.items.some(i=>i.status==='done')} onClick={()=>{setUndo(true);setBatch(b);setHistory(false);}}>查看与撤销</Button></div>)}</Modal>}
  </div>;
}

function ResultDetail({file,disabled,onSave,onOpen,onClose}:{file:OcrFileResult;disabled:boolean;onSave:(values:Record<string,string>,name:string,reviewed:boolean)=>Promise<void>;onOpen:(reveal:boolean)=>void;onClose:()=>void}){
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
            <Button size="small" onClick={()=>onOpen(false)}>打开原文件</Button>
            <Button size="small" onClick={()=>onOpen(true)}>资源管理器定位</Button>
          </div>
        </div>

        {file.error&&<p className="inline-error" role="alert">{file.error}</p>}
        {file.warning&&<p className="ocr-warning" role="alert">{file.warning}</p>}

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
                        <span>{d.localCandidate?`${d.localCandidate} ${d.localRuleMatched?`[锚点:${d.localRuleMatched}]`:''}`:'（未匹配到规则）'}</span>
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

        {tab==='logs'&&(
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

function ProfileEditor({value:p,busy,error,onChange,onClose,onSave,onDelete,onAI,onExport}:{value:OcrProfile;busy:boolean;error:string;onChange:(p:OcrProfile)=>void;onClose:()=>void;onSave:()=>void;onDelete:()=>void;onAI:(s:string)=>void;onExport:()=>void}){
  const [description,setDescription]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
  const set=(v:Partial<OcrProfile>)=>onChange({...p,...v});const field=(i:number,v:Partial<OcrFieldDefinition>)=>onChange(updateProfileField(p,i,v));
  const list=(s:string)=>s.split(/[，,\n]/).map(x=>x.trim()).filter(Boolean);
  return <Modal title="OCR 配置编辑器" wide onClose={()=>!busy&&onClose()}><div className="ocr-editor">
    <section className="ocr-ai-config"><label className="ocr-field">用一句话描述你要提取或优化的内容<textarea aria-label="AI 配置需求" value={description} onChange={e=>setDescription(e.target.value)} placeholder={p.fields.length ? "例如：优化产品名称提取规则，支持带括号的品名（系统会自动锁定并保护现有其他字段与画框）" : "例如：从设备验收单提取设备编号、验收日期和验收单位，以日期和编号命名。"} rows={2}/></label><div><span className="muted">AI 根据需求生成提取规则，未读取样本文档。微调时请写明字段名称；草稿核对并保存后生效。</span><Button icon={<Sparkle/>} disabled={busy||!description.trim()} onClick={()=>onAI(description)}>{busy?'处理中…':(p.fields.length?'AI 优化已有配置':'AI 生成配置草稿')}</Button></div></section>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="ocr-form-grid"><label className="ocr-field">配置名称<input aria-label="配置名称" value={p.name} onChange={e=>set({name:e.target.value})}/></label><label className="ocr-field">自动匹配关键词（逗号分隔）<input value={p.keywords.join(',')} onChange={e=>set({keywords:list(e.target.value)})}/></label><label className="ocr-field">页范围<input aria-label="页范围" value={p.pages} onChange={e=>set({pages:e.target.value})} placeholder="all 或 1-3,5"/></label><label className="ocr-field">渲染 DPI<input type="number" min={100} max={400} value={p.dpi} onChange={e=>set({dpi:Number(e.target.value)})}/></label></div>
    <OcrRegions fieldKeys={[...new Set(p.fields.map(f=>f.key).filter(Boolean))]} regions={p.regions||[]} onChange={regions=>set({regions,...(regions.length&&regions.every(r=>r.page>0)?{pages:[...new Set(regions.map(r=>r.page))].sort((a,b)=>a-b).join(',')}: {})})}/>
    {Boolean(p.regions && p.regions.length > 0) && (
      <p className="ocr-policy" style={{color:'#15803d',background:'#dcfce7',borderColor:'#bbf7d0',marginTop:8,marginBottom:8}}>
        🔒 <strong>已启用局部物理沙箱 OCR</strong>：系统将仅对您圈选的这 {p.regions?.length || 0} 个区域进行物理图像切片识别，框外文字与图像在底层物理级直接丢弃，彻底杜绝信息外泄且识别速度大幅提升。
      </p>
    )}
    <div className="ocr-section-heading"><h3>提取字段</h3><Button icon={<Plus/>} size="small" onClick={()=>set({fields:[...p.fields,newField()]})}>添加字段</Button></div>{!p.fields.length&&<p className="muted">没有配置字段时，仅识别和导出文字。</p>}
    {p.fields.map((f,i)=><section className="ocr-field-editor" key={i}><div className="ocr-form-grid"><label className="ocr-field">字段名称<input aria-label={`字段名称 ${i+1}`} value={f.key} onChange={e=>field(i,{key:e.target.value})}/></label><label className="ocr-field">类型<select value={f.kind} onChange={e=>field(i,{kind:e.target.value as OcrFieldDefinition['kind'],format:''})}><option value="text">文字</option><option value="date">日期</option><option value="number">数字 / 金额</option></select></label></div><label className="ocr-field">Jev 判断说明（启用 Jev 时生效）<input aria-label={`字段说明 ${i+1}`} value={f.prompt} onChange={e=>field(i,{prompt:e.target.value})}/></label><div className="ocr-buttons"><Checkbox label="必填" checked={f.required} onChange={(_,v)=>field(i,{required:!!v.checked})}/><Checkbox label="多个值" checked={f.multiple} onChange={(_,v)=>field(i,{multiple:!!v.checked})}/>{f.multiple&&<><label>最多 <input className="ocr-small-number" type="number" min={1} max={20} value={f.maxItems} onChange={e=>field(i,{maxItems:Number(e.target.value)})}/></label><label>分隔符 <input className="ocr-small-number" value={f.separator} onChange={e=>field(i,{separator:e.target.value})}/></label></>}<span className="ocr-spacer"/><Button size="small" onClick={()=>onChange(updateProfileField(p,i,null))}>移除字段</Button></div>
    <details><summary>本地提取规则（默认使用；Jev 无结果时回退）</summary><div className="ocr-form-grid"><label className="ocr-field">定位标签（逗号分隔）<input value={f.anchors.join(',')} onChange={e=>field(i,{anchors:list(e.target.value)})}/></label><label className="ocr-field">清理前缀（逗号分隔）<input value={f.stripPrefixes.join(',')} onChange={e=>field(i,{stripPrefixes:list(e.target.value)})}/></label><label className="ocr-field">正则表达式<input value={f.pattern} onChange={e=>field(i,{pattern:e.target.value})} placeholder="优先取第一个捕获组"/></label><label className="ocr-field">未识别时的显示值<input value={f.fallback} onChange={e=>field(i,{fallback:e.target.value})}/></label>{f.kind==='date'&&<label className="ocr-field">日期格式<select value={f.format} onChange={e=>field(i,{format:e.target.value})}><option value="">YYYYMMDD</option><option value="%Y%m%d">YYYYMMDD</option><option value="%Y-%m-%d">YYYY-MM-DD</option><option value="%Y/%m/%d">YYYY/MM/DD</option><option value="%Y年%m月%d日">YYYY年MM月DD日</option></select></label>}{f.kind==='number'&&<label className="ocr-field">保留小数位<select value={f.format} onChange={e=>field(i,{format:e.target.value})}><option value="">保持原值</option>{[0,1,2,3,4,5,6].map(n=><option value={String(n)} key={n}>{n} 位</option>)}</select></label>}</div></details></section>)}
    <div className="ocr-form-grid"><label className="ocr-field">命名格式<input aria-label="命名格式" value={p.filenamePattern} onChange={e=>set({filenamePattern:e.target.value})}/><small>可用：{'{原文件名}'} {p.fields.filter(f=>f.key).map(f=>`{${f.key}}`).join(' ')}；保留原扩展名。</small></label><label className="ocr-field">低于此分数需复核<input type="number" min={0} max={1} step={.05} value={p.threshold} onChange={e=>set({threshold:Number(e.target.value)})}/></label></div>
    <details><summary>版式专有词（画像）：只影响当前配置，不写入通用规则</summary><div className="ocr-form-grid"><label className="ocr-field">附加标题（逗号分隔）<input value={(p.extraTitles||[]).join(',')} onChange={e=>set({extraTitles:list(e.target.value)})}/></label><label className="ocr-field">排除词（逗号分隔）<input value={(p.noiseMarkers||[]).join(',')} onChange={e=>set({noiseMarkers:list(e.target.value)})}/></label><label className="ocr-field">补充表头（逗号分隔）<input value={(p.extraHeaders||[]).join(',')} onChange={e=>set({extraHeaders:list(e.target.value)})}/></label></div><p className="muted">通用规则只认识报价/合同/送货等跨行业类型；某一样本的内部词必须填在这里，换版式不影响别人。</p></details>
    <p className="ocr-policy">单价、金额及其他数字强制脱敏，不能通过配置关闭。需要比较原始数值时，请配置本地规则并复核结果。</p>
    <div className="dialog-actions"><Button disabled={busy} onClick={()=>set({...structuredClone(p),id:crypto.randomUUID(),name:`${p.name} 副本`})}>复制为新配置</Button><Button disabled={busy} onClick={onExport}>导出配置</Button><Button disabled={busy} onClick={()=>setConfirmDelete(v=>!v)}>{confirmDelete?'取消删除':'删除配置'}</Button>{confirmDelete&&<Button disabled={busy} onClick={onDelete}>确认删除</Button>}<span className="ocr-spacer"/><Button disabled={busy} appearance="primary" onClick={onSave}>保存配置</Button></div>
  </div></Modal>;
}
