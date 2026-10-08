import { useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FluentProvider, webDarkTheme, webLightTheme, Button, Checkbox, type Theme } from '@fluentui/react-components';
import { IconContext, FolderSimple, MagnifyingGlass, Command, Sparkle, GearSix, Info, CaretRight, ArrowSquareOut, Copy, ArrowClockwise, Plus, FileText, FilePdf, FileXls, FileDoc, X, ArrowLeft, ArrowRight, SquaresFour, Translate, ArrowUpRight, FunnelSimple, Check, HardDrives, Sun, Moon, Stop, CheckSquare } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { api, copy, pick, demo, desktop } from './api';
import type { Settings, Status, Bootstrap, Entry, Results, AIResult, Proposal } from './types';
import { basename, selectLevel, locateTrail, samePath, relativePath, sizeLabel, isWithin, openActionKey } from './domain';
import { DirectoryPanel, Empty, IconButton, Modal, Skeleton, Splitter } from './components';
import { ProposalDiff } from './ProposalDiff';
import { hasPricingChange } from './assistantPricing';
import { ReasoningSelect } from './ReasoningSelect';
import { SettingsView, type ModuleId } from './SettingsView';
import { AboutView } from './AboutView';
import { ToolsWorkbench } from './ToolsWorkbench';
import { TranslatePane, useTranslationSync, type BlockRange, type PaneSide } from './TranslatePane';
import { alignTranslationBlocks, balanceFences, detectFormat, mapBlockRange, segmentBlocks, FORMAT_LABELS, type SourceFormat } from './translateFormat';
import { htmlToPlainText } from './htmlTokens';
import { getLauncherVisual } from './launcherVisuals';
import { useFilePreview } from './useFilePreview';
import { FilePreview } from './FilePreview';
const pageModuleMap: Record<string, ModuleId> = { files: 'workspace', tools: 'tools', translate: 'model', ocr: 'integrations', todo: 'workspace' };
const Assistant=lazy(()=>import('./Assistant'));
const OcrWorkbench=lazy(()=>import('./OcrWorkbench'));
const TodoWorkbench=lazy(()=>import('./TodoWorkbench'));
const initialStatus:Status={scanning:false,count:0,scanned:0,errors:[],generation:0};
const quickShortcutHint=desktop?'窗口内 Ctrl + K · 全局 Ctrl + Shift + Space':'窗口内 Ctrl + K';
function storedPercent(variable:string,fallback:number){try{const value=parseFloat(localStorage.getItem(`office-${variable}`)||'');return Number.isFinite(value)?value:fallback;}catch{return fallback;}}
function useDirs(path:string,generation:number){
  const [data,setData]=useState<{items:Entry[];busy:boolean;error:string;path:string}>({items:[],busy:false,error:'',path:''});
  const previous=useRef(path);
  useEffect(()=>{
    let active=true;
    if(!path){setData({items:[],busy:false,error:'',path});return;}
    const changed=previous.current!==path;
    previous.current=path;
    if(changed){setData({items:[],busy:true,error:'',path});}
    void api<Entry[]>('list_dirs',{path}).then(items=>{
      if(!active)return;
      setData(prev=>{
        if(prev.path===path&&prev.items.length===items.length&&prev.items.every((it,idx)=>it.path===items[idx].path&&it.modified===items[idx].modified&&it.name===items[idx].name)){
          return prev.busy||prev.error?{...prev,busy:false,error:''}:prev;
        }
        return {items,busy:false,error:'',path};
      });
    }).catch(e=>{if(active)setData({items:[],busy:false,error:String(e),path});});
    return()=>{active=false;};
  },[path,generation]);
  return data.path===path?data:{items:[],busy:!!path,error:'',path};
}
function useDebounce<T>(value:T,delay=140){const [result,setResult]=useState(value);useEffect(()=>{const timer=setTimeout(()=>setResult(value),delay);return()=>clearTimeout(timer);},[value,delay]);return result;}
function FileIcon({extension}:{extension:string}){const Icon=extension==='pdf'?FilePdf:['xlsx','xls','csv'].includes(extension)?FileXls:['docx','doc'].includes(extension)?FileDoc:FileText;return <span className={`file-icon ${extension}`}><Icon size={22} weight="duotone"/></span>;}

export default function App(){
  const [settings,setSettings]=useState<Settings|null>(null),[status,setStatus]=useState<Status>(initialStatus),[fatal,setFatal]=useState('');
  const [page,setPage]=useState('files'),[root,setRoot]=useState(''),[trail,setTrail]=useState<string[]>([]),[query,setQuery]=useState(''),[filter,setFilter]=useState(''),[recursive,setRecursive]=useState(true),[extension,setExtension]=useState(''),[after,setAfter]=useState(''),[filters,setFilters]=useState(false),[offset,setOffset]=useState(0);
  const pageRef=useRef(page);pageRef.current=page;
  const [deepSelected,setDeepSelected]=useState<{parent:string;entry:Entry}|null>(null),[deepExpanded,setDeepExpanded]=useState(false);
  const pendingRef=useRef(new Set<string>()),[pendingActions,setPendingActions]=useState<ReadonlySet<string>>(new Set());
  const [filesQueryKey,setFilesQueryKey]=useState('');
  const [files,setFiles]=useState<Results>({items:[],total:0}),[fileBusy,setFileBusy]=useState(false),[fileError,setFileError]=useState(''),[selected,setSelected]=useState<Entry|null>(null);
  const [settingsTab,setSettingsTab]=useState<ModuleId|null>(null),[assistant,setAssistant]=useState(false),[quick,setQuick]=useState(false),[quickQuery,setQuickQuery]=useState(''),[quickFiles,setQuickFiles]=useState<Entry[]>([]),[quickIndex,setQuickIndex]=useState(0),[notice,setNotice]=useState(''),[proposal,setProposal]=useState<Proposal|null>(null),[proposalError,setProposalError]=useState(''),[proposalBusy,setProposalBusy]=useState(false),[systemDark,setSystemDark]=useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [about,setAbout]=useState(false);
  const openSettings=(target?:ModuleId|string)=>{const validModules:ModuleId[]=['workspace','tools','model','assistant','pricing','integrations','transfer'];const resolved=(target&&validModules.includes(target as ModuleId))?(target as ModuleId):(pageModuleMap[page]||'workspace');setSettingsTab(resolved);};
  const [source,setSource]=useState(''),[translated,setTranslated]=useState(''),[language,setLanguage]=useState('zh'),[translationTask,setTranslationTask]=useState(''),[translationError,setTranslationError]=useState('');
  const translationRun=useRef('');
  const [translationSource,setTranslationSource]=useState<string|null>(null);
  const sourceFormat=useMemo(()=>detectFormat(source),[source]);
  const [targetFormat,setTargetFormat]=useState<SourceFormat>('plain'),[sourcePreview,setSourcePreview]=useState(false);
  const [syncOn,setSyncOn]=useState(()=>localStorage.getItem('office-translate-sync')!=='off'),[focus,setFocus]=useState<{side:PaneSide;range:BlockRange}|null>(null),[fenceNotice,setFenceNotice]=useState(false);
  const sourceBlocks=useMemo(()=>segmentBlocks(source,sourceFormat),[source,sourceFormat]);
  const targetBlocks=useMemo(()=>segmentBlocks(translated,targetFormat),[translated,targetFormat]);
  const alignment=useMemo(()=>alignTranslationBlocks(source,translated,sourceFormat,targetFormat,sourceBlocks,targetBlocks),[source,translated,sourceFormat,targetFormat,sourceBlocks,targetBlocks]);
  const sourceChanged=translationSource!==null&&source!==translationSource;
  const matchingReady=!translationTask&&!translationError&&!sourceChanged&&translationSource!==null&&alignment.reliable;
  const matchingNotice=translated&&!translationTask?(sourceChanged?'原文已修改，当前译文对应的是修改前的内容。重新翻译后恢复对应高亮和同步滚动。':!alignment.reliable?'原文与译文的段落结构不一致，已暂停对应高亮和同步滚动，避免错误匹配。请核对译文或重新翻译。':''):'';
  const sync=useTranslationSync({enabled:syncOn&&matchingReady,sourceBlocks,targetBlocks,alignment,resetKey:translationTask});
  useEffect(()=>{setFocus(null);},[source,translated]);
  // A highlight is a momentary cue, so it clears itself instead of lingering.
  useEffect(()=>{if(!focus)return;const timer=setTimeout(()=>setFocus(null),2500);return()=>clearTimeout(timer);},[focus]);
  // The highlight marks the counterpart, so it belongs on the pane the user did not select in.
  const focusFor=(side:PaneSide)=>syncOn&&matchingReady&&focus&&focus.side!==side?focus.range:null;
  const onPaneSelection=(side:PaneSide)=>(range:BlockRange|null)=>{const mapped=syncOn&&matchingReady?mapBlockRange(range,side==='source'?alignment.forward:alignment.backward):null;setFocus(mapped?{side,range:mapped}:null);};
  const toggleSync=()=>{setFocus(null);setSyncOn(value=>{try{localStorage.setItem('office-translate-sync',value?'off':'on');}catch{/* 存储失败不影响当前同步开关。 */}return !value;});};
  const [jevTask,setJevTask]=useState(''),[jevResult,setJevResult]=useState<AIResult|null>(null);
  const [ocrIncoming,setOcrIncoming]=useState<string[]>([]),[ocrVisited,setOcrVisited]=useState(false),[todoVisited,setTodoVisited]=useState(false);
  const [todoReminder,setTodoReminder]=useState<{id:string}|null>(null);
  useEffect(()=>{if(page==='ocr')setOcrVisited(true);if(page==='todo')setTodoVisited(true);},[page]);
  const workspace=useRef<HTMLDivElement>(null),columns=useRef<HTMLDivElement>(null),fileList=useRef<HTMLDivElement>(null),searchInput=useRef<HTMLInputElement>(null),quickResults=useRef<HTMLDivElement>(null);
  const q=useDebounce(query),f=useDebounce(filter),quickQ=useDebounce(quickQuery);
  const browseDirectory=trail.at(-1)||root,deepParent=trail.length>=3?browseDirectory:'';
  const current=deepSelected&&samePath(deepSelected.parent,deepParent)?deepSelected.entry.path:browseDirectory;
  const d1=useDirs(root,status.generation),d2=useDirs(trail[0]||'',status.generation),d3=useDirs(trail[1]||'',status.generation),d4=useDirs(deepParent,status.generation);
  const showDeep=!!deepParent&&(d4.busy?deepExpanded:!!d4.error||d4.items.length>0);
  useEffect(()=>{if(!d4.busy)setDeepExpanded(!!deepParent&&(!!d4.error||d4.items.length>0));},[deepParent,d4.busy,d4.error,d4.items.length]);
  useEffect(()=>{
    if(deepSelected&&samePath(deepSelected.parent,deepParent)&&!d4.busy&&!d4.error&&!d4.items.some(e=>samePath(e.path,deepSelected.entry.path))){setDeepSelected(null);setNotice('所选目录已移动或删除，已返回当前目录。');}
  },[deepSelected,deepParent,d4.busy,d4.error,d4.items]);
  useEffect(()=>{
    const missing=[d1,d2,d3,d4].filter(data=>data.error.startsWith('路径已不存在：'));
    const removed=trail.findIndex(path=>missing.some(data=>samePath(path,data.path)));
    if(removed>=0){setDeepSelected(null);setTrail(value=>value.slice(0,removed));setNotice('目录已移动或删除，已返回上级目录。');}
  },[trail,d1,d2,d3,d4]);
  const fileQueryKey=`${root}|${current}|${q}|${f}|${recursive}|${extension}|${after}|${offset}`;
  const resultsReady=filesQueryKey===fileQueryKey;
  const virtual=useVirtualizer({count:resultsReady?files.items.length:0,getScrollElement:()=>fileList.current,getItemKey:index=>files.items[index]?.path||index,estimateSize:()=>54,overscan:8});
  const scrollMemory=useRef(new Map<string,number>()),fileScope=q?`search:${q}:${offset}`:`browse:${current}:${offset}`,fileInteraction=useRef(false);
  const preview=useFilePreview(page==='files'&&!settingsTab&&!about&&!quick&&!assistant,`${fileScope}|${settings?.roots.join('|')}|${f}|${recursive}|${extension}|${after}`,files.items);
  const lastQueryKey=useRef(''),selectedRef=useRef<Entry|null>(null);
  selectedRef.current=selected;
  useLayoutEffect(()=>{fileInteraction.current=false;},[fileScope,fileBusy]);
  useLayoutEffect(()=>{if(fileBusy)return;const value=scrollMemory.current.get(fileScope)||0;if(fileList.current)fileList.current.scrollTop=value;const frame=requestAnimationFrame(()=>{if(fileList.current)fileList.current.scrollTop=value;});return()=>cancelAnimationFrame(frame);},[fileBusy,fileScope,files.items]);
  useEffect(()=>{void api<Bootstrap>('bootstrap').then(b=>{let last:{root?:string;current?:string}={};try{last=JSON.parse(localStorage.getItem(demo?'office-demo-location':'office-location')||'{}');}catch{/* A damaged UI preference must not prevent startup. */}const restored=b.settings.roots.find(r=>typeof last.root==='string'&&samePath(r,last.root))||b.settings.roots[0]||'';setRoot(restored);if(restored&&typeof last.current==='string'&&isWithin(last.current,restored))setTrail(locateTrail(restored,last.current));setSettings(b.settings);setStatus(b.status);setRecursive(b.settings.recursive);setFilter(b.settings.filter);}).catch(e=>setFatal(String(e)));},[]);
  useEffect(()=>{if(settings){try{localStorage.setItem(demo?'office-demo-location':'office-location',JSON.stringify({root,current:browseDirectory}));}catch{/* Browsing remains available without preference storage. */}}},[settings,root,browseDirectory]);
  useEffect(()=>{
    let alive=true;
    const timer=setInterval(()=>{
      void api<Status>('index_status').then(s=>{
        if(!alive)return;
        setStatus(prev=>{
          if(
            prev.scanning===s.scanning&&
            prev.count===s.count&&
            prev.scanned===s.scanned&&
            prev.generation===s.generation&&
            prev.errors.length===s.errors.length&&
            prev.errors.every((e,i)=>e===s.errors[i])
          ){
            return prev;
          }
          return s;
        });
      }).catch(()=>{});
    },1000);
    return()=>{alive=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{const m=matchMedia('(prefers-color-scheme: dark)');const fn=()=>setSystemDark(m.matches);m.addEventListener('change',fn);return()=>m.removeEventListener('change',fn);},[]);
  useEffect(()=>{if(!notice||(pendingActions.size&&notice.startsWith('正在')))return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer);},[notice,pendingActions]);
  useEffect(()=>{const listener=(e:KeyboardEvent)=>{if(e.ctrlKey&&e.key.toLowerCase()==='k'){e.preventDefault();setQuick(s=>!s);}if(e.ctrlKey&&e.key.toLowerCase()==='f'){if(pageRef.current==='todo'&&document.querySelector('dialog[open]'))return;e.preventDefault();if(pageRef.current==='todo'){document.getElementById('todo-search')?.focus();}else if(pageRef.current==='tools'){document.getElementById('tools-search')?.focus();}else{setPage('files');searchInput.current?.focus();}}if(e.key==='Escape'){setAssistant(false);setQuick(false);}};window.addEventListener('keydown',listener);const unlisten=desktop?listen('quick-open',()=>setQuick(true)):null;return()=>{window.removeEventListener('keydown',listener);void unlisten?.then(f=>f());};},[]);
  useLayoutEffect(()=>{
    const area=workspace.current,ancestors=columns.current;if(!area||!ancestors)return;
    const resize=()=>{
      const width=area.getBoundingClientRect().width;if(width<1||window.innerWidth<768)return;
      const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
      const left=showDeep?clamp(storedPercent('--left',75),500/width*100,100-170/width*100):100;
      area.style.setProperty('--left',`${left}%`);
      const available=ancestors.getBoundingClientRect().width;if(available<500)return;
      const first=clamp(storedPercent('--col-one',33),160/available*100,100-340/available*100);
      const second=clamp(storedPercent('--col-two',66),first+170/available*100,100-170/available*100);
      ancestors.style.setProperty('--col-one',`${first}%`);ancestors.style.setProperty('--col-two',`${second}%`);
    };
    const observer=new ResizeObserver(resize);observer.observe(area);observer.observe(ancestors);resize();return()=>observer.disconnect();
  },[root,showDeep,page]);
  useEffect(()=>{
    if(!desktop)return;
    const unlisten=listen<string>('todo-reminder-open',event=>{setPage('todo');setAssistant(false);setQuick(false);setSettingsTab(null);if(typeof event.payload==='string'&&event.payload)setTodoReminder({id:event.payload});});
    return()=>{void unlisten.then(stop=>stop());};
  },[]);
  useEffect(()=>{setOffset(0);},[q,f,current,recursive,extension,after]);
  useEffect(()=>{
    let active=true;
    if(!root){setFiles({items:[],total:0});return;}
    const currentQueryKey=fileQueryKey;
    const queryChanged=lastQueryKey.current!==currentQueryKey;
    lastQueryKey.current=currentQueryKey;
    if(queryChanged){
      setFileBusy(true);
      setFileError('');
      setSelected(null);
      setJevResult(null);
    }
    void api<Results>('search',{query:{query:q,root:q?undefined:current,recursive:q?true:recursive,filter:q?'':f,extension,after:after?Math.floor(new Date(`${after}T00:00:00`).getTime()/1000):undefined,offset,limit:100}}).then(result=>{
      if(!active)return;
      setFilesQueryKey(currentQueryKey);
      setFiles(prev=>{
        if(prev.total===result.total&&prev.items.length===result.items.length&&prev.items.every((it,idx)=>{const n=result.items[idx];return n&&it.path===n.path&&it.modified===n.modified&&it.size===n.size;})){
          return prev;
        }
        return result;
      });
      if(!queryChanged&&selectedRef.current){
        const cur=selectedRef.current;
        const found=result.items.find(e=>samePath(e.path,cur.path));
        if(found)setSelected(found);
      }
    }).catch(e=>{
      if(active){setFileError(String(e));setFiles({items:[],total:0});setFilesQueryKey(currentQueryKey);}
    }).finally(()=>{
      if(active)setFileBusy(false);
    });
    return()=>{active=false;};
  },[q,f,current,root,recursive,extension,after,offset,status.generation]);
  useEffect(()=>{let active=true;setQuickFiles([]);if(!quick||quickQuery!==quickQ)return;void api<Results>('search',{query:{query:quickQ,recursive:true,limit:8}}).then(r=>{if(active)setQuickFiles(r.items);}).catch(e=>setNotice(String(e)));return()=>{active=false;};},[quick,quickQ,quickQuery]);
  const quickLaunchers=(settings?.launchers||[]).filter(l=>l.name.toLowerCase().includes(quickQuery.toLowerCase())||l.path.toLowerCase().includes(quickQuery.toLowerCase())).slice(0,5);
  const quickCount=quickLaunchers.length+quickFiles.length,activeQuickIndex=Math.min(quickIndex,Math.max(0,quickCount-1));
  useEffect(()=>{setQuickIndex(0);},[quick,quickQuery]);
  useEffect(()=>{if(quick)quickResults.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[quick,activeQuickIndex,quickFiles,quickQuery]);
  function quickKeyDown(event:ReactKeyboardEvent<HTMLInputElement>){
    if(event.nativeEvent.isComposing||!quickCount||!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
    event.preventDefault();
    if(event.key==='Enter'){if(!event.repeat)quickResults.current?.querySelectorAll<HTMLButtonElement>('button')[activeQuickIndex]?.click();}
    else setQuickIndex((activeQuickIndex+(event.key==='ArrowDown'?1:-1)+quickCount)%quickCount);
  }
  const dark=settings?.theme==='dark'||(settings?.theme==='system'&&systemDark);
  const theme:Theme={...(dark?webDarkTheme:webLightTheme),fontFamilyBase:'"Geist Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif',colorBrandBackground:dark?'#c2e783':'#293329',colorBrandBackgroundHover:dark?'#d0efa4':'#3a4937',colorBrandBackgroundPressed:dark?'#aed866':'#182217',colorNeutralForegroundOnBrand:dark?'#172014':'#f7faf2',borderRadiusMedium:'8px',colorCompoundBrandBackground:'#5b753c',colorCompoundBrandBackgroundHover:'#49622f',colorCompoundBrandStroke:'#657e43'};
  async function run(fn:()=>Promise<unknown>){try{await fn();}catch(e){setNotice(String(e));}}
  function saved(next:Settings){if(next.recursive!==settings?.recursive)setRecursive(next.recursive);if(next.filter!==settings?.filter)setFilter(next.filter);setSettings(next);if(!next.roots.some(r=>samePath(r,root))){setRoot(next.roots[0]||'');setTrail([]);}}
  async function addRoot(){if(!settings)return;const path=await pick(true);if(path){const next=await api<Settings>('save_settings',{next:{...settings,roots:[...new Set([...settings.roots,path])]}});saved(next);setRoot(path);setTrail([]);}}
  function browseTo(next:string[]){setDeepSelected(null);setTrail(next);setQuery('');setOffset(0);setSelected(null);}
  function choose(level:number,e:Entry){browseTo(selectLevel(trail,level,e.path));}
  function selectDeep(e:Entry){if(!samePath(e.parent,deepParent))return;setDeepSelected({parent:deepParent,entry:e});setQuery('');setOffset(0);setSelected(null);}
  function enterDeep(e:Entry){if(samePath(e.parent,deepParent))browseTo([...trail,e.path]);}
  function locate(e:Entry){const found=settings?.roots.find(r=>isWithin(e.path,r));if(!found){setNotice('文件不在当前搜索范围');return;}setRoot(found);browseTo(locateTrail(found,e.parent));setQuick(false);setPage('files');}
  async function openAction(target:string,label:string,reveal:boolean,action:()=>Promise<unknown>){
    const key=openActionKey(target,reveal);if(pendingRef.current.has(key))return;
    pendingRef.current.add(key);setPendingActions(new Set(pendingRef.current));setNotice(`正在${reveal?'定位':'打开'} ${label}…`);
    try{await action();setNotice(`已发送到系统：${label}`);}catch(e){setNotice(`无法${reveal?'定位':'打开'} ${label}：${String(e)}`);}finally{pendingRef.current.delete(key);setPendingActions(new Set(pendingRef.current));}
  }
  const openPath=(path:string,reveal=false)=>void openAction(path,basename(path),reveal,()=>api('open_path',{path,reveal}));
  const openEntry=(e:Entry,reveal=false)=>openPath(e.path,reveal);
  function launchTool(id:string,reveal=false){const launcher=settings?.launchers.find(l=>l.id===id);if(launcher)void openAction(launcher.path,launcher.name,reveal,()=>api(reveal?'reveal_launcher':'launch',{id}));}
  const copyValue=(s:string)=>void run(async()=>{await copy(s);setNotice('已复制');});
  function clearTranslation(){
    const id=translationRun.current;translationRun.current='';
    setSource('');setTranslated('');setTranslationSource(null);setTranslationTask('');setTranslationError('');setTargetFormat('plain');setFocus(null);setFenceNotice(false);
    if(desktop&&id)void run(()=>api('cancel_task',{id}));
  }
  async function translate(){
    if(translationRun.current)return;
    const id=crypto.randomUUID();translationRun.current=id;setTranslationSource(source);setTranslationTask(id);setTranslationError('');setTranslated('');setTargetFormat(sourceFormat);setFocus(null);setFenceNotice(false);
    let stopStream:(()=>void)|undefined;
    try{
      if(desktop){stopStream=await listen<{id:string;text:string}>('translation-stream',e=>{if(e.payload.id===id&&translationRun.current===id)setTranslated(e.payload.text);});}
      if(translationRun.current!==id)return;
      const v=await api<AIResult>('ai_task',{id,kind:'translate',text:source,language});
      if(translationRun.current!==id)return;
      if(v.text){
        // The backend reports the format it actually translated, so the preview never
        // disagrees with the structure the model was asked to preserve.
        setTargetFormat(v.format||sourceFormat);
        const balanced=balanceFences(v.text);setFenceNotice(balanced.repaired);setTranslated(balanced.text);
      }
    }catch(e){if(translationRun.current===id){setTranslationError(String(e));setTargetFormat(sourceFormat);}}
    finally{stopStream?.();if(translationRun.current===id){translationRun.current='';setTranslationTask('');}}
  }
  async function evaluateJev(){const id=crypto.randomUUID();setJevTask(id);setJevResult(null);try{const result=await api<AIResult>('ai_task',{id,kind:'jev',text:q,items:files.items.slice(0,20).map(e=>({name:e.name,path:relativePath(e.path,settings?.roots.find(r=>isWithin(e.path,r))||root)}))});setJevResult(result);}catch(e){setNotice(`${e}；保留本地搜索结果`);}finally{setJevTask('');}}
  const directoryProps={onOpen:(e:Entry)=>openEntry(e),onCopy:copyValue};
  const viewContext={page,root,currentDirectory:current,selectedDirectories:trail,query,filter,recursive,selectedFile:selected?{name:selected.name,path:selected.path}:null};
  return <FluentProvider theme={theme} className={`office-app ${dark?'dark':''}`}><IconContext.Provider value={{size:18,weight:'regular'}}>
    <header className="app-header"><div className="wordmark"><span className="brand-mark"><SquaresFour size={22} weight="fill"/></span><span>MultiTool <strong>Office</strong></span></div><nav aria-label="主导航">{[{id:'files',label:'文件工作区',icon:<FolderSimple/>},{id:'translate',label:'文本翻译',icon:<Translate/>},{id:'tools',label:'常用工具',icon:<SquaresFour/>},{id:'ocr',label:'文档 OCR',icon:<FileText/>},{id:'todo',label:'待办事项',icon:<CheckSquare/>}].map(t=><button className={page===t.id?'active':''} onClick={()=>setPage(t.id)} key={t.id} title={t.label} aria-label={t.label}>{t.icon}{page===t.id&&<span>{t.label}</span>}</button>)}</nav><div className="header-actions"><button className="quick-trigger" onClick={()=>setQuick(true)} aria-label="快捷面板" title={quickShortcutHint}><Command/><kbd>Ctrl K</kbd></button><IconButton label="关于" onClick={()=>setAbout(true)}><Info/></IconButton><IconButton label="设置" onClick={()=>openSettings()}><GearSix/></IconButton><Button appearance="primary" className="assistant-toggle" aria-label="助手" icon={<Sparkle weight="fill"/>} onClick={()=>setAssistant(a=>!a)}>助手</Button></div></header>
    {demo&&<div className="demo-banner">交互预览 · 当前为示例文件，系统操作请使用桌面版</div>}
    {fatal?<div className="fatal"><h2>无法加载工作台</h2><p>{fatal}</p><Button onClick={()=>location.reload()}>重新加载</Button></div>:!settings?<Skeleton/>:<>
      <main className="main-content">
        <div className="workspace-page" hidden={page!=='files'}>
          <div className="page-heading"><div><h1>文件工作区<span className="heading-dot">/</span><span className="heading-sub">一切，就在手边。</span></h1><p>沿着熟悉的路径，让工作更快一步。</p></div><button className="index-indicator" onClick={()=>setFilters(s=>!s)} title={status.errors.join('\n')||'查看索引状态'}><span className={`status-dot ${status.scanning?'busy':''}`}/>{status.scanning?`正在索引 ${status.scanned.toLocaleString()} 个文件`:`${status.count.toLocaleString()} 个文件已就绪`}<HardDrives/></button></div>
          <div className="toolbar"><label className="root-picker"><FolderSimple/><select aria-label="工作目录" value={root} onChange={e=>{setRoot(e.target.value);browseTo([]);}}><option value="" disabled>选择工作目录</option>{settings.roots.map(r=><option key={r} value={r}>{basename(r)}</option>)}</select><IconButton label="添加工作目录" onClick={()=>void run(addRoot)}><Plus/></IconButton></label><label className="search-field"><MagnifyingGlass/><span className="sr-only">全局搜索</span><input aria-label="全局搜索" ref={searchInput} value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索所有工作目录中的文件…"/>{query?<IconButton label="清除搜索" onClick={()=>setQuery('')}><X/></IconButton>:<kbd>Ctrl F</kbd>}</label><label className="filter-field"><FunnelSimple/><span className="sr-only">当前范围筛选</span><input value={filter} disabled={!!query} onChange={e=>setFilter(e.target.value)} placeholder="当前范围筛选"/></label><IconButton label="更多筛选与索引状态" onClick={()=>setFilters(v=>!v)}><FunnelSimple weight={filters?'fill':'regular'}/></IconButton></div>
          {filters&&<div className="filters"><label>扩展名<input value={extension} onChange={e=>setExtension(e.target.value)} placeholder="如 pdf"/></label><label>修改时间起始<input type="date" value={after} onChange={e=>setAfter(e.target.value)}/></label><Button onClick={()=>void run(()=>api('reindex'))} icon={<ArrowClockwise/>}>重新索引</Button><span>{status.scanning?'正在更新，可继续浏览':'本地索引'}{status.errors.length>0&&<details><summary>{status.errors.length} 个目录问题</summary>{status.errors.map((e,i)=><p key={i}>{e}</p>)}</details>}</span></div>}
          <div className="breadcrumb"><button onClick={()=>browseTo([])} title={root}><HardDrives/>{root?basename(root):'尚未添加目录'}</button>{trail.map((p,i)=><span key={p}><CaretRight size={12}/><button className={i===trail.length-1?'current':''} onClick={()=>browseTo(trail.slice(0,i+1))} title={p}>{basename(p)}</button></span>)}<div className="breadcrumb-actions"><IconButton label="复制当前路径" disabled={!root} onClick={()=>copyValue(browseDirectory)}><Copy/></IconButton><IconButton label="打开当前目录" disabled={!root} onClick={()=>openPath(browseDirectory)}><ArrowSquareOut/></IconButton></div></div>
          {!root?<div className="onboarding"><div className="onboarding-icon"><FolderSimple size={46} weight="thin"/></div><h2>给工作资料一个入口。</h2><p>添加常用目录，保留三级路径同时可见。<br/>所有文件信息都保存在本机。</p><Button appearance="primary" size="large" icon={<Plus/>} onClick={()=>void run(addRoot)}>添加工作目录</Button><button className="text-button" onClick={()=>openSettings('transfer')}>导入配置文件 <ArrowUpRight/></button></div>:<div className={`workspace-grid ${showDeep?'has-deep':'without-deep'}`} ref={workspace} style={{'--left':`${showDeep?storedPercent('--left',75):100}%`,'--top':`${Math.max(30,Math.min(65,storedPercent('--top',47)))}%`} as CSSProperties}>
            <div className="upper-left" ref={columns} style={{'--col-one':`${storedPercent('--col-one',33)}%`,'--col-two':`${storedPercent('--col-two',66)}%`} as CSSProperties}>
              <DirectoryPanel title="第一级目录" level={1} parent={root} selected={trail[0]} {...d1} {...directoryProps} onSelect={e=>choose(0,e)}/>

              <DirectoryPanel title="第二级目录" level={2} parent={trail[0]||''} selected={trail[1]} {...d2} {...directoryProps} onSelect={e=>choose(1,e)}/>
            <DirectoryPanel title="第三级目录" level={3} parent={trail[1]||''} selected={trail[2]} {...d3} {...directoryProps} className="lower-left" onSelect={e=>choose(2,e)}/>
              <Splitter axis="x" container={columns} variable="--col-one" min={0} max={100} minPixels={[160,160]} nextVariable="--col-two"/><Splitter axis="x" container={columns} variable="--col-two" min={0} max={100} minPixels={[160,160]} previousVariable="--col-one"/>
            </div>
            {showDeep&&<DirectoryPanel title={trail.length>3?`第 ${trail.length+1} 级目录`:'第四级及更深目录'} level={Math.max(4,trail.length+1)} parent={deepParent} selected={deepSelected&&samePath(deepSelected.parent,deepParent)?deepSelected.entry.path:undefined} {...d4} {...directoryProps} className="upper-right" onSelect={selectDeep} onEnter={enterDeep} onBack={trail.length>3?()=>browseTo(trail.slice(0,-1)):undefined}/>}
            <section className="file-panel panel" aria-label="文件列表"><div className="panel-head"><div className="panel-title"><span className="file-heading-icon"><FileText/></span><h2>{q?'搜索结果':'文件列表'}</h2><span className="count">{resultsReady?files.total:'…'}</span></div><Checkbox checked={!!q||recursive} title={q?'搜索始终包含所有工作目录的子文件夹':undefined} disabled={!!q} onChange={(_,d)=>setRecursive(!!d.checked)} label="包含子文件夹"/></div><div className="file-list-top"><span>{q?`“${q}” · 所有工作目录`:current?basename(current):'文件'}</span>{q&&settings.jevEnabled&&<Button size="small" appearance="subtle" disabled={!!jevTask} icon={<Sparkle/>} onClick={()=>void evaluateJev()}>{jevTask?'正在评分':'JEV 实验评分'}</Button>}</div>
              {jevResult&&<div className="jev-result"><Check size={14}/>Jev 建议：{jevResult.answers?.intent?.choice||'已评分'}，仅供参考<IconButton label="关闭评分" onClick={()=>setJevResult(null)}><X/></IconButton></div>}
              <div className="file-list" ref={fileList} onWheel={()=>{fileInteraction.current=true;}} onPointerDown={()=>{fileInteraction.current=true;}} onKeyDown={()=>{fileInteraction.current=true;}} onScroll={e=>{if(!fileBusy&&fileInteraction.current)scrollMemory.current.set(fileScope,e.currentTarget.scrollTop);}}>
                {!resultsReady||fileBusy?<Skeleton/>:fileError?<div className="inline-error">{fileError}</div>:!files.items.length?<Empty title={status.scanning?'索引中，稍后显示文件':'没有匹配的文件'} detail={q||f?'试试更短的关键词或清除筛选':'可选择其他目录，或关闭范围限制'}/>:<div style={{height:virtual.getTotalSize(),position:'relative'}}>{virtual.getVirtualItems().map(v=>{const e=files.items[v.index];return <div className={`file-row ${selected?.path===e.path?'selected':''}`} data-index={v.index} ref={virtual.measureElement} key={e.path} style={{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${v.start}px)`}} tabIndex={0} role="button" aria-busy={pendingActions.has(openActionKey(e.path))} aria-label={e.name} title={e.path} onPointerEnter={event=>preview.hover(e,event)} onPointerMove={event=>preview.hover(e,event)} onPointerLeave={preview.leave} onClick={event=>{setSelected(e);if(event.ctrlKey)preview.pin(e,event.currentTarget);}} onDoubleClick={event=>{if(!event.ctrlKey)openEntry(e);}} onContextMenu={event=>{event.preventDefault();openEntry(e,true);}} onKeyDown={event=>{if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();preview.pin(e,event.currentTarget);return;}if(event.key==='Enter'&&!event.repeat)openEntry(e);if(event.key===' '){event.preventDefault();setSelected(e);}}}>
                    <FileIcon extension={e.extension}/><div className="file-description"><strong>{e.name}</strong><span>{relativePath(e.parent,q?settings.roots.find(r=>isWithin(e.path,r))||root:current)||'当前目录'}</span></div><div className="file-meta"><span>{sizeLabel(e.size)}</span><span>{new Date(e.modified*1000).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'})}</span></div>{jevResult?.answers?.[`file_${v.index}`]?.score!==undefined&&<span className="score" title="仅根据名称与相对路径评分">{jevResult.answers[`file_${v.index}`].score?.toFixed(1)}</span>}
                  </div>;})}</div>}
              </div>
              <div className="file-actions">{resultsReady&&selected?<><span title={selected.name}>{selected.name}</span><IconButton label="复制文件名称" onClick={()=>copyValue(selected.name)}><FileText/></IconButton><IconButton label="复制文件路径" onClick={()=>copyValue(selected.path)}><Copy/></IconButton><Button size="small" onClick={event=>preview.pin(selected,event.currentTarget)}>预览文件</Button><IconButton label="打开文件" disabled={pendingActions.has(openActionKey(selected.path))} onClick={()=>openEntry(selected)}><ArrowSquareOut/></IconButton><Button size="small" onClick={()=>locate(selected)}>工作区定位</Button>{/^(pdf|png|jpe?g|bmp|tiff?)$/i.test(selected.extension)&&<Button size="small" onClick={()=>{setOcrIncoming([selected.path]);setPage('ocr');}}>送入 OCR</Button>}</>:<span>Ctrl 悬停预览 · Ctrl＋左键固定 · 双击打开</span>}{resultsReady&&files.total>100&&<div className="pagination"><IconButton label="上一页" disabled={!offset} onClick={()=>setOffset(x=>Math.max(0,x-100))}><ArrowLeft/></IconButton><span>{Math.floor(offset/100)+1}/{Math.ceil(files.total/100)}</span><IconButton label="下一页" disabled={offset+100>=files.total} onClick={()=>setOffset(x=>x+100)}><ArrowRight/></IconButton></div>}</div>
            </section>
            {showDeep&&<Splitter axis="x" container={workspace} variable="--left" min={0} max={100} minPixels={[500,160]}/>}<Splitter axis="y" container={workspace} variable="--top" min={30} max={65}/>
          </div>}
        </div>
        <div className="translation-page" hidden={page!=='translate'}><div className="page-heading"><div><h1>文本翻译<span className="heading-dot">/</span><span className="heading-sub">让表达跨越语言。</span></h1><p>保留格式，准确传达。只处理你主动提交的文本。</p></div></div><div className="translation-grid"><TranslatePane side="source" title="原文" subtitle="自动识别语言" text={source} format={sourceFormat} blocks={sourceBlocks} scrollRef={sync.sourceScroll} docRef={sync.sourceDoc} sourceMirror={sync.sourceMirror} focusedRange={focusFor('source')} editable preview={sourcePreview} onPreviewChange={setSourcePreview} onTextChange={setSource} onInteract={()=>sync.markActive('source')} onScroll={()=>sync.handleScroll('source')} onSelection={onPaneSelection('source')} id="source" label="翻译原文" placeholder="在这里粘贴需要翻译的文字…" headerExtra={<span className={`format-badge ${sourceFormat}`}>{FORMAT_LABELS[sourceFormat]}</span>} footer={<><span>{source.length.toLocaleString()} 字符</span><Button appearance="subtle" onClick={clearTranslation}>清空</Button></>}/><TranslatePane side="target" title="译文" text={translated} format={targetFormat} blocks={targetBlocks} scrollRef={sync.targetScroll} docRef={sync.targetDoc} focusedRange={focusFor('target')} onInteract={()=>sync.markActive('target')} onScroll={()=>sync.handleScroll('target')} onSelection={onPaneSelection('target')} label="翻译结果" placeholder={translationTask?'正在翻译…':'译文将显示在这里'} headerExtra={<><span className={`format-badge ${targetFormat}`}>{FORMAT_LABELS[targetFormat]}</span><button type="button" className={`translate-toggle ${syncOn?'on':''}`} aria-pressed={syncOn} onClick={toggleSync}>同步滚动</button><select aria-label="目标语言" value={language} onChange={e=>setLanguage(e.target.value)}><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option></select></>} footer={<><span>{translationTask?'正在调用模型':fenceNotice?'已修正代码块围栏':'可直接复制使用'}</span><span className="translate-copy">{targetFormat==='html'&&<Button appearance="subtle" disabled={!translated} onClick={()=>copyValue(htmlToPlainText(translated))}>复制纯文本</Button>}<Button icon={<Copy/>} disabled={!translated} onClick={()=>copyValue(translated)}>复制译文</Button></span></>}/></div>{matchingNotice&&<p className="translate-notice" role="status">{matchingNotice}</p>}{fenceNotice&&<p className="translate-notice" role="status">译文中的代码块围栏未闭合，已自动补齐以便正常显示。</p>}{translationError&&<p className="inline-error" role="alert">{translationError}</p>}<div className="translation-actions"><ReasoningSelect label="翻译思考程度" value={settings.translationReasoning||'default'} disabled={!!translationTask} onChange={value=>void run(async()=>saved(await api<Settings>('save_settings',{next:{...settings,translationReasoning:value}})))}/><span>文本会发送到你配置的模型服务</span>{translationTask?<Button icon={<Stop/>} onClick={()=>void run(()=>api('cancel_task',{id:translationTask}))}>取消翻译</Button>:<Button appearance="primary" size="large" icon={<Translate/>} disabled={!source.trim()} onClick={()=>void translate()}>{translationError?'重试翻译':'开始翻译'}</Button>}</div></div>
        <div className="tools-page" hidden={page!=='tools'}><ToolsWorkbench launchers={settings.launchers} pendingActions={pendingActions} onLaunch={id=>launchTool(id)} onOpenFolder={id=>launchTool(id,true)} onCopyPath={copyValue} onOpenSettings={tab=>openSettings(tab||'tools')}/></div>
        {(ocrVisited||page==='ocr')&&<Suspense fallback={<Skeleton/>}><OcrWorkbench visible={page==='ocr'} incoming={ocrIncoming} onConsumed={done=>setOcrIncoming(current=>current.filter(path=>!done.includes(path)))} onSettings={()=>openSettings('integrations')}/></Suspense>}
        {(todoVisited||page==='todo')&&<Suspense fallback={<Skeleton/>}><TodoWorkbench visible={page==='todo'} reminderRequest={todoReminder}/></Suspense>}
      </main>
      <footer className="statusbar"><span><span className="status-dot"/>本地工作台</span><span>{root?basename(root):'添加目录即可开始'}<span className="status-divider"/>{status.scanning?'正在同步索引':'文件信息保存在本机'}</span><span className="statusbar-right"><button onClick={()=>setQuick(true)} title={quickShortcutHint}>快捷面板 <kbd>Ctrl K</kbd></button><IconButton label={dark?'切换浅色':'切换深色'} onClick={()=>void run(async()=>saved(await api<Settings>('save_settings',{next:{...settings,theme:dark?'light':'dark'}})))}>{dark?<Sun/>:<Moon/>}</IconButton></span></footer>
      <Suspense fallback={null}><Assistant settings={settings} onPricingSettings={()=>openSettings('pricing')} onLocate={path=>{const found=settings.roots.find(r=>isWithin(path,r));if(!found){setNotice('目录不在当前搜索范围');return;}setRoot(found);setTrail(locateTrail(found,path));setQuery('');setPage('files');setAssistant(false);}} open={assistant} onClose={()=>setAssistant(false)} context={viewContext} onProposal={p=>{setProposal(p);setProposalError('');}}/></Suspense>
      {about&&<AboutView onClose={()=>setAbout(false)}/>}
      {settingsTab&&<SettingsView settings={settings} initialTab={settingsTab} onSaved={saved} onClose={()=>setSettingsTab(null)}/>}
      {proposal&&<Modal title={hasPricingChange(proposal)?'确认计价调整':'确认配置变更'} onClose={()=>{if(!proposalBusy)setProposal(null);}} wide><p className="proposal-confirm-hint">{hasPricingChange(proposal)?'检查下方调整建议。确认后用于下一次任务，历史费用保留原单价。':'检查下方调整建议，确认后应用。'}</p><ProposalDiff proposal={proposal}/>{proposalError&&<p className="inline-error" role="alert">{proposalError}</p>}<div className="dialog-actions"><span>需要你的确认才会生效</span><Button disabled={proposalBusy} onClick={()=>{setProposalBusy(true);void api('decide_proposal',{id:proposal.id,approve:false}).then(()=>setProposal(null)).catch(e=>setProposalError(String(e))).finally(()=>setProposalBusy(false));}}>不应用</Button><Button disabled={proposalBusy} appearance="primary" onClick={()=>{setProposalBusy(true);void api<Settings>('decide_proposal',{id:proposal.id,approve:true}).then(s=>{saved(s);setProposal(null);setNotice('配置已更新');}).catch(e=>setProposalError(String(e))).finally(()=>setProposalBusy(false));}}>{proposalBusy?'正在处理…':'确认并应用'}</Button></div></Modal>}
      {quick&&<Modal title="快捷面板" onClose={()=>setQuick(false)}>
        <label className="quick-search"><MagnifyingGlass/><span className="sr-only">搜索文件与工具</span><input autoFocus role="combobox" aria-autocomplete="list" aria-expanded aria-controls="quick-results" aria-activedescendant={quickCount?`quick-result-${activeQuickIndex}`:undefined} value={quickQuery} onChange={e=>setQuickQuery(e.target.value)} onKeyDown={quickKeyDown} placeholder="搜索文件或常用工具…"/></label>
        <div className="quick-results" id="quick-results" role="listbox" aria-label="文件与工具候选" ref={quickResults}>
          {quickLaunchers.map((l,index)=>{const visual=getLauncherVisual(l);const IconComp=visual.icon;return <button key={l.id} id={`quick-result-${index}`} role="option" aria-selected={activeQuickIndex===index} onMouseEnter={()=>setQuickIndex(index)} className={`quick-launcher-item ${activeQuickIndex===index?'active':''}`} disabled={pendingActions.has(openActionKey(l.path))} onClick={()=>{setQuick(false);launchTool(l.id);}}><span className="quick-launcher-icon" style={{color:visual.theme.primary,backgroundColor:visual.theme.subtle}}><IconComp size={16} weight="duotone"/></span><span><strong>{l.name}</strong><small>{visual.label} · {visual.subtitle}</small></span><span className="quick-launcher-badge" style={{color:visual.theme.badgeText,backgroundColor:visual.theme.badgeBg}}>{visual.badge}</span><ArrowUpRight size={14}/></button>;})}
          {quickFiles.map((e,index)=>{const itemIndex=quickLaunchers.length+index;return <button key={e.path} id={`quick-result-${itemIndex}`} role="option" aria-selected={activeQuickIndex===itemIndex} className={activeQuickIndex===itemIndex?'active':''} onMouseEnter={()=>setQuickIndex(itemIndex)} onClick={()=>locate(e)}><FileIcon extension={e.extension}/><span>{e.name}<small>{relativePath(e.parent,root)}</small></span><CaretRight/></button>;})}
          {!quickCount&&<p className="muted">输入关键词查找文件，或前往设置添加常用工具。</p>}
        </div>
        <p className="notice">{quickShortcutHint}</p>
      </Modal>}
    </>}
    {preview.target&&<FilePreview key={preview.target.entry.path} target={preview.target} request={preview.request} generation={status.generation} onClose={preview.close} onPin={preview.pinPanel} onEnter={preview.enterPanel} onLeave={preview.leavePanel} onOpen={openEntry}/>}
    {notice&&<div className="toast" role="status">{notice}<IconButton label="关闭提示" onClick={()=>setNotice('')}><X/></IconButton></div>}
  </IconContext.Provider></FluentProvider>;
}


