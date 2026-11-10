import { useEffect, useLayoutEffect, useRef, useState, lazy, Suspense, type CSSProperties } from 'react';
import { FluentProvider, webDarkTheme, webLightTheme, Button, Checkbox, type Theme } from '@fluentui/react-components';
import { IconContext, FolderSimple, MagnifyingGlass, Command, Sparkle, GearSix, Info, CaretRight, ArrowSquareOut, Copy, ArrowClockwise, Plus, FileText, X, ArrowLeft, ArrowRight, SquaresFour, ArrowUpRight, FunnelSimple, Check, HardDrives, Sun, Moon, CheckSquare, PencilSimple, ArrowCounterClockwise } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { api, copy, pick, demo, desktop } from './api';
import type { Settings, Status, Bootstrap, Entry, Results, AIResult, Proposal } from './types';
import { basename, cleanPath, selectLevel, locateTrail, samePath, relativePath, sizeLabel, isWithin, openActionKey, renamedPath } from './domain';
import { DirectoryPanel, Empty, IconButton, Modal, Skeleton, Splitter } from './components';
import { ProposalDiff } from './ProposalDiff';
import { hasPricingChange } from './assistantPricing';
import type { OcrDiagnosticRequest } from './OcrDiagnosticShare';
import { SettingsView, isSettingsModule, type ModuleId } from './SettingsView';
import { AboutView } from './AboutView';
import { NetworkConsent, NetworkIndicator, openSetup } from './NetworkControls';
import { SetupWizard } from './SetupWizard';
import { ToolsWorkbench } from './ToolsWorkbench';
import { DirectoryFilter } from './DirectoryFilter';
import { QuickPanel } from './QuickPanel';
import { useQuickHistory } from './quickHistory';
import { useFilePreview } from './useFilePreview';
import { FilePreview } from './FilePreview';
import { FileIcon } from './FileIcon';
import { useFileDrag } from './useFileDrag';
import { WorkspaceRenameDialog, WorkspaceRenameHistory, type RenameRecord } from './WorkspaceRename';
import { ariaShortcut, defaultShortcuts, keyboardShortcut, shortcutLabels, shortcutText } from './shortcuts';
const moduleNavigation=[
  {id:'files',icon:<FolderSimple/>},
  {id:'tools',icon:<SquaresFour/>},
  {id:'ocr',icon:<FileText/>},
  {id:'todo',icon:<CheckSquare/>},
] as const;
const pageModuleMap: Record<string, ModuleId> = { files: 'workspace', tools: 'tools', ocr: 'integrations', todo: 'workspace' };
const Assistant=lazy(()=>import('./Assistant'));
const OcrWorkbench=lazy(()=>import('./OcrWorkbench'));
const TodoWorkbench=lazy(()=>import('./TodoWorkbench'));
const initialStatus:Status={scanning:false,count:0,scanned:0,errors:[],generation:0};
const fileSelectionKey=(entry:Entry)=>cleanPath(entry.path).toLowerCase();
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

export default function App(){
  const [diagnosticRequest,setDiagnosticRequest]=useState<OcrDiagnosticRequest|null>(null);
  const [settings,setSettings]=useState<Settings|null>(null),[status,setStatus]=useState<Status>(initialStatus),[fatal,setFatal]=useState('');
  const settingsRef=useRef(settings);settingsRef.current=settings;
  const shortcuts=settings?.shortcuts??defaultShortcuts;
  const globalKey=desktop?shortcuts.globalQuick:null;
  const [globalStatus,setGlobalStatus]=useState<{key:string;active:boolean}|null>(null);
  const globalShortcutActive=globalStatus?.key===globalKey?globalStatus.active:undefined;
  const quickShortcutHint=[
    shortcuts.quick&&'窗口内 '+shortcutText(shortcuts.quick),
    globalKey&&globalShortcutActive!==false&&'全局 '+shortcutText(globalKey),
  ].filter(Boolean).join(' · ')||'快捷面板';
  useEffect(()=>{
    if(!globalKey){setGlobalStatus(null);return;}
    let current=true;
    void api<boolean>('global_shortcut_registered').then(active=>{if(current)setGlobalStatus({key:globalKey,active});}).catch(()=>{});
    return()=>{current=false;};
  },[globalKey]);
  const [page,setPage]=useState('files'),[root,setRoot]=useState(''),[trail,setTrail]=useState<string[]>([]),[query,setQuery]=useState(''),[filter,setFilter]=useState(''),[recursive,setRecursive]=useState(true),[extension,setExtension]=useState(''),[after,setAfter]=useState(''),[filters,setFilters]=useState(false),[offset,setOffset]=useState(0);
  const pageRef=useRef(page);pageRef.current=page;
  const [deepSelected,setDeepSelected]=useState<{parent:string;entry:Entry}|null>(null),[deepExpanded,setDeepExpanded]=useState(false);
  const pendingRef=useRef(new Set<string>()),[pendingActions,setPendingActions]=useState<ReadonlySet<string>>(new Set());
  const [filesQueryKey,setFilesQueryKey]=useState('');
  const [files,setFiles]=useState<Results>({items:[],total:0}),[fileBusy,setFileBusy]=useState(false),[fileError,setFileError]=useState('');
  const [selectedPaths,setSelectedPaths]=useState<ReadonlySet<string>>(()=>new Set());
  const [settingsTab,setSettingsTab]=useState<ModuleId|null>(null),[assistant,setAssistant]=useState(false),[quick,setQuick]=useState(false),[notice,setNotice]=useState(''),[proposal,setProposal]=useState<Proposal|null>(null),[proposalError,setProposalError]=useState(''),[proposalBusy,setProposalBusy]=useState(false),[systemDark,setSystemDark]=useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [directoryFilter,setDirectoryFilter]=useState('');
  useEffect(()=>setDirectoryFilter(''),[root]);
  const [locationRevision,setLocationRevision]=useState(0);
  const recent=useQuickHistory(),locating=useRef<Entry|null>(null),scrollToLocated=useRef(false);
  const [about,setAbout]=useState(false);
  const [renameEntry,setRenameEntry]=useState<Entry|null>(null),[renameHistory,setRenameHistory]=useState(false);
  const openSettings=(target?:string)=>setSettingsTab(target&&isSettingsModule(target)?target:pageModuleMap[page]||'workspace');
  const [jevTask,setJevTask]=useState(''),[jevResult,setJevResult]=useState<AIResult|null>(null);
  const [ocrIncoming,setOcrIncoming]=useState<string[]>([]),[ocrVisited,setOcrVisited]=useState(false),[todoVisited,setTodoVisited]=useState(false);
  const [todoReminder,setTodoReminder]=useState<{id:string}|null>(null);
  useEffect(()=>{if(page==='ocr')setOcrVisited(true);if(page==='todo')setTodoVisited(true);},[page]);
  const workspace=useRef<HTMLDivElement>(null),columns=useRef<HTMLDivElement>(null),fileList=useRef<HTMLDivElement>(null),searchInput=useRef<HTMLInputElement>(null);
  const focusWorkspaceSearch=useRef(false);
  useLayoutEffect(()=>{if(page==='files'&&focusWorkspaceSearch.current){focusWorkspaceSearch.current=false;searchInput.current?.focus();}},[page]);
  const q=useDebounce(query),f=useDebounce(filter);
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
  const fileQueryKey=`${root}|${current}|${q}|${f}|${recursive}|${extension}|${after}|${offset}|${locationRevision}`;
  const resultsReady=filesQueryKey===fileQueryKey;
  const selectedFiles=resultsReady&&!fileBusy&&selectedPaths.size?files.items.filter(entry=>selectedPaths.has(fileSelectionKey(entry))):[];
  const selectedFile=selectedFiles.length===1?selectedFiles[0]:null;
  const multipleSelected=selectedFiles.length>1;
  const virtual=useVirtualizer({count:resultsReady?files.items.length:0,getScrollElement:()=>fileList.current,getItemKey:index=>files.items[index]?.path||index,estimateSize:()=>40,overscan:8});
  const scrollMemory=useRef(new Map<string,number>()),fileScope=q?`search:${q}:${offset}`:`browse:${current}:${offset}`,fileInteraction=useRef(false);
  const preview=useFilePreview(page==='files'&&!settingsTab&&!about&&!quick&&!assistant&&!renameEntry&&!renameHistory&&!multipleSelected,`${fileScope}|${settings?.roots.join('|')}|${f}|${recursive}|${extension}|${after}`,files.items);
  const dragProps=useFileDrag(setNotice,preview.close);
  const lastQueryKey=useRef('');
  useLayoutEffect(()=>{fileInteraction.current=false;},[fileScope,fileBusy]);
  useLayoutEffect(()=>{if(fileBusy||scrollToLocated.current)return;const value=scrollMemory.current.get(fileScope)||0;if(fileList.current)fileList.current.scrollTop=value;const frame=requestAnimationFrame(()=>{if(fileList.current)fileList.current.scrollTop=value;});return()=>cancelAnimationFrame(frame);},[fileBusy,fileScope,files.items]);
  useLayoutEffect(()=>{if(scrollToLocated.current&&selectedFile){const index=files.items.indexOf(selectedFile);if(index>=0){virtual.scrollToIndex(index,{align:'auto'});scrollToLocated.current=false;}}},[selectedFile,files.items]);
  useEffect(()=>{void api<Bootstrap>('bootstrap').then(b=>{let last:{root?:string;current?:string}={};try{last=JSON.parse(localStorage.getItem(demo?'office-demo-location':'office-location')||'{}');}catch{/* A damaged UI preference must not prevent startup. */}const restored=b.settings.roots.find(r=>typeof last.root==='string'&&samePath(r,last.root))||b.settings.roots[0]||'';setRoot(restored);if(restored&&typeof last.current==='string'&&isWithin(last.current,restored))setTrail(locateTrail(restored,last.current));setSettings(b.settings);setStatus(b.status);setRecursive(b.settings.recursive);setFilter(b.settings.filter);}).catch(e=>setFatal(String(e)));},[]);
  useEffect(()=>{if(settings){try{localStorage.setItem(demo?'office-demo-location':'office-location',JSON.stringify({root,current:browseDirectory}));}catch{/* Browsing remains available without preference storage. */}}},[settings,root,browseDirectory]);
  useEffect(()=>{if(settings&&!settings.roots.some(r=>samePath(r,root))){locating.current=null;setRoot(settings.roots[0]||'');setTrail([]);setDeepSelected(null);setSelectedPaths(new Set());}},[settings?.roots,root]);
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
  useEffect(()=>{if(!desktop)return;const unlisten=listen<Settings>('settings-updated',event=>setSettings(previous=>!previous||event.payload.revision>previous.revision?event.payload:previous));return()=>{void unlisten.then(stop=>stop());};},[]);
  useEffect(()=>{if(!notice||(pendingActions.size&&notice.startsWith('正在')))return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer);},[notice,pendingActions]);
  useEffect(()=>{
    const listener=(e:KeyboardEvent)=>{
      if(e.defaultPrevented||e.isComposing||e.key==='Process'||e.repeat)return;
      const binding=keyboardShortcut(e);
      if(!binding&&e.key!=='Escape')return;
      const dialog=document.querySelector('dialog[open]:not(.quick-panel),[role="dialog"][aria-modal="true"]');
      if(dialog)return;
      if(e.key==='Escape'){setAssistant(false);setQuick(false);return;}
      const bindings=settingsRef.current?.shortcuts??defaultShortcuts;
      if(binding===bindings.quick){e.preventDefault();setQuick(s=>!s);return;}
      if(document.querySelector('.quick-panel[open]'))return;
      if(binding===bindings.search){
        e.preventDefault();
        if(pageRef.current==='todo')document.getElementById('todo-search')?.focus();
        else if(pageRef.current==='tools')document.getElementById('tools-search')?.focus();
        else if(pageRef.current==='files')searchInput.current?.focus();
        else{focusWorkspaceSearch.current=true;setPage('files');}
        return;
      }
      const editing=e.target instanceof Element&&e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
      const module=moduleNavigation.find(tab=>bindings[tab.id]===binding);
      if(module&&!editing){
        e.preventDefault();setPage(module.id);
        document.getElementById('module-nav-'+module.id)?.focus();
      }
    };
    window.addEventListener('keydown',listener);const unlisten=desktop?listen('quick-open',()=>{
      if(!document.querySelector('.shortcut-capture[data-recording]'))setQuick(true);
    }):null;
    return()=>{window.removeEventListener('keydown',listener);void unlisten?.then(f=>f());};
  },[]);
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
  useEffect(()=>{if(!locating.current)setOffset(0);},[q,f,current,recursive,extension,after]);
  useEffect(()=>{
    let active=true;
    if(!root){setFiles({items:[],total:0});return;}
    const currentQueryKey=fileQueryKey;
    const queryChanged=lastQueryKey.current!==currentQueryKey;
    lastQueryKey.current=currentQueryKey;
    if(queryChanged){
      setFileBusy(true);
      setFileError('');
      if(!locating.current)setSelectedPaths(new Set());
      setJevResult(null);
    }
    void api<Results>('search',{query:{query:q,root:q?undefined:current,recursive:q?true:recursive,filter:f,extension,after:after?Math.floor(new Date(`${after}T00:00:00`).getTime()/1000):undefined,offset,limit:100}}).then(result=>{
      if(!active)return;
      setFilesQueryKey(currentQueryKey);
      const target=locating.current;
      if(target&&samePath(target.parent,current)&&!q&&!f&&!extension&&!after){const found=result.items.find(e=>samePath(e.path,target.path));if(found){scrollToLocated.current=true;setSelectedPaths(new Set([fileSelectionKey(found)]));locating.current=null;}else{setNotice('目标文件已变化，请刷新索引后重新定位。');locating.current=null;}}
      setFiles(prev=>{
        if(prev.total===result.total&&prev.items.length===result.items.length&&prev.items.every((it,idx)=>{const n=result.items[idx];return n&&it.path===n.path&&it.modified===n.modified&&it.size===n.size;})){
          return prev;
        }
        return result;
      });
      if(!queryChanged){
        const resultPaths=new Set(result.items.map(fileSelectionKey));
        setSelectedPaths(paths=>{
          const remaining=new Set([...paths].filter(path=>resultPaths.has(path)));
          return remaining.size===paths.size?paths:remaining;
        });
      }
    }).catch(e=>{
      if(active){locating.current=null;setFileError(String(e));setFiles({items:[],total:0});setFilesQueryKey(currentQueryKey);}
    }).finally(()=>{
      if(active)setFileBusy(false);
    });
    return()=>{active=false;};
  },[q,f,current,root,recursive,extension,after,offset,status.generation,locationRevision]);
  const dark=settings?.theme==='dark'||(settings?.theme==='system'&&systemDark);
  const theme:Theme={...(dark?webDarkTheme:webLightTheme),fontFamilyBase:'"Geist Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif',colorBrandBackground:dark?'#c2e783':'#293329',colorBrandBackgroundHover:dark?'#d0efa4':'#3a4937',colorBrandBackgroundPressed:dark?'#aed866':'#182217',colorNeutralForegroundOnBrand:dark?'#172014':'#f7faf2',borderRadiusMedium:'8px',colorCompoundBrandBackground:'#5b753c',colorCompoundBrandBackgroundHover:'#49622f',colorCompoundBrandStroke:'#657e43'};
  async function run(fn:()=>Promise<unknown>){try{await fn();}catch(e){setNotice(String(e));}}
  function saved(next:Settings){if(next.recursive!==settings?.recursive)setRecursive(next.recursive);if(next.filter!==settings?.filter)setFilter(next.filter);setSettings(next);if(!next.roots.some(r=>samePath(r,root))){setRoot(next.roots[0]||'');browseTo([]);}}
  async function addRoot(){if(!settings)return;const path=await pick(true);if(path){const next=await api<Settings>('save_settings',{next:{...settings,roots:[...new Set([...settings.roots,path])]}});saved(next);setRoot(path);browseTo([]);}}
  function selectFile(entry:Entry,toggle=false){
    const key=fileSelectionKey(entry);
    if(!toggle){setSelectedPaths(new Set([key]));return;}
    preview.close();
    setSelectedPaths(paths=>{
      const next=new Set(paths);
      if(!next.delete(key))next.add(key);
      return next;
    });
  }
  function browseTo(next:string[]){locating.current=null;setDeepSelected(null);setTrail(next);setQuery('');setOffset(0);setSelectedPaths(new Set());}
  function choose(level:number,e:Entry){browseTo(selectLevel(trail,level,e.path));}
  function selectDeep(e:Entry){if(!samePath(e.parent,deepParent))return;locating.current=null;setDeepSelected({parent:deepParent,entry:e});setQuery('');setOffset(0);setSelectedPaths(new Set());}
  function enterDeep(e:Entry){if(samePath(e.parent,deepParent))browseTo([...trail,e.path]);}
  async function locatePath(path:string,isDir:boolean){
    if(!settingsRef.current?.roots.some(r=>isWithin(path,r)))throw new Error('目标已超出当前工作目录范围，请重新选择。');
    const result=await api<{entry:Entry;offset:number}>('locate_entry',{path,isDir});
    const found=settingsRef.current?.roots.filter(r=>isWithin(result.entry.path,r)).sort((a,b)=>b.length-a.length)[0];if(!found)throw new Error('目标位置或工作目录授权已变化，请重新选择。');
    locating.current=isDir?null:result.entry;setRoot(found);setDeepSelected(null);setTrail(locateTrail(found,isDir?result.entry.path:result.entry.parent));setSelectedPaths(new Set());setOffset(result.offset);
    if(!isDir)setLocationRevision(v=>v+1);
    setDirectoryFilter('');setQuery('');setFilter('');setExtension('');setAfter('');setRecursive(false);
    setPage('files');
  }
  function locate(e:Entry){void run(()=>locatePath(e.path,e.isDir));}
  async function openAction(target:string,label:string,reveal:boolean,action:()=>Promise<unknown>){
    const key=openActionKey(target,reveal);if(pendingRef.current.has(key))return false;
    pendingRef.current.add(key);setPendingActions(new Set(pendingRef.current));setNotice(`正在${reveal?'定位':'打开'} ${label}…`);
    try{await action();setNotice(`已发送到系统：${label}`);return true;}catch(e){setNotice(`无法${reveal?'定位':'打开'} ${label}：${String(e)}`);return false;}finally{pendingRef.current.delete(key);setPendingActions(new Set(pendingRef.current));}
  }
  const openDirectory=(path:string)=>void openAction(path,basename(path),false,async()=>{await api('open_path',{path,reveal:false});recent.opened({path,name:basename(path),isDir:true});});
  const openEntry=(e:Entry,reveal=false)=>void openAction(e.path,e.name,reveal,async()=>{await api('open_path',{path:e.path,reveal});if(!reveal)recent.opened(e);});
  async function launchTool(id:string,reveal=false){const launcher=settings?.launchers.find(l=>l.id===id);if(!launcher)return false;return openAction(launcher.path,launcher.name,reveal,()=>api(reveal?'reveal_launcher':'launch',{id,expectedPath:launcher.path}));}
  const copyValue=(s:string)=>void run(async()=>{await copy(s);setNotice('已复制');});
  async function evaluateJev(){const id=crypto.randomUUID();setJevTask(id);setJevResult(null);try{const result=await api<AIResult>('ai_task',{id,kind:'jev',text:q,items:files.items.slice(0,20).map(e=>({name:e.name,path:relativePath(e.path,settings?.roots.find(r=>isWithin(e.path,r))||root)}))});setJevResult(result);}catch(e){setNotice(`${e}；保留本地搜索结果`);}finally{setJevTask('');}}
  function beginRename(entry:Entry){preview.close();if(!desktop){setNotice('安全改名请在 Windows 桌面版使用。');return;}setRenameEntry(entry);}
  function renamed(record:RenameRecord){
    const from=record.status==='undone'?record.target:record.original,to=record.status==='undone'?record.original:record.target;
    preview.close();locating.current=null;setSelectedPaths(new Set());setDeepSelected(null);
    setTrail(paths=>paths.map(path=>renamedPath(path,from,to)));
    setFiles({items:[],total:0});setFilesQueryKey('');setLocationRevision(value=>value+1);setStatus(value=>({...value,generation:value.generation+1}));
    setOcrIncoming(paths=>paths.filter(path=>!isWithin(path,from)&&!isWithin(path,to)));recent.relocate(from,to);
    window.dispatchEvent(new CustomEvent('workspace-renamed',{detail:{from,to}}));
    setNotice(record.warning||(record.status==='undone'?'已撤销改名':'已完成改名，可在改名记录中撤销'));
    void locatePath(to,record.isDir).catch(error=>setNotice(`文件操作已完成，定位失败：${String(error)}`));
  }
  const directoryProps={dragProps,onOpen:(e:Entry)=>openEntry(e),onCopy:copyValue,onRename:beginRename,filterText:directoryFilter};
  const viewContext={page,root,currentDirectory:current,selectedDirectories:trail,query,filter,recursive,selectedFile:selectedFile?{name:selectedFile.name,path:selectedFile.path}:null};
  const indexLabel=status.scanning?`正在索引 ${status.scanned.toLocaleString()} 个文件`:`${status.count.toLocaleString()} 个文件已就绪`;
  const scopeLabel=q?`“${q}” · 所有工作目录`:basename(current);
  const ocrPaths=selectedFiles.filter(entry=>/^(pdf|png|jpe?g|bmp|tiff?)$/i.test(entry.extension)).map(entry=>entry.path);
  return <FluentProvider theme={theme} className={`office-app ${dark?'dark':''}`}><IconContext.Provider value={{size:18,weight:'regular'}}>
    <header className="app-header">
      <div className="wordmark"><span className="brand-mark"><SquaresFour size={22} weight="fill"/></span><span>MultiTool <strong>Office</strong></span></div>
      <nav aria-label="主导航">{moduleNavigation.map(t=>{
        const binding=shortcuts[t.id],label=shortcutLabels[t.id];
        return <button id={'module-nav-'+t.id} className={page===t.id?'active':''} onClick={()=>setPage(t.id)} key={t.id} title={binding?label+' · '+shortcutText(binding):label} aria-label={label} aria-keyshortcuts={ariaShortcut(binding)} aria-current={page===t.id?'page':undefined}>{t.icon}{page===t.id&&<span>{label}</span>}</button>;
      })}</nav>
      <div className="header-actions"><button className="quick-trigger" onClick={()=>setQuick(true)} aria-label="快捷面板" aria-keyshortcuts={ariaShortcut(shortcuts.quick)} title={quickShortcutHint}><Command/>{shortcuts.quick&&<kbd>{shortcutText(shortcuts.quick)}</kbd>}</button><IconButton label="关于" onClick={()=>setAbout(true)}><Info/></IconButton><IconButton label="设置" onClick={()=>openSettings()}><GearSix/></IconButton><Button appearance="primary" className="assistant-toggle" aria-label="助手" icon={<Sparkle weight="fill"/>} onClick={()=>setAssistant(a=>!a)}>助手</Button></div>
    </header>
    <div className="network-status-bar"><NetworkIndicator onOpen={()=>openSettings('privacy')}/><span>本地文件整理 · 外部服务按需授权</span><Button type="button" size="small" appearance="subtle" onClick={()=>openSetup()}>配置引导</Button></div>
    {demo&&<div className="demo-banner">交互预览 · 当前为示例文件，系统操作请使用桌面版</div>}
    {fatal?<div className="fatal"><h2>无法加载工作台</h2><p>{fatal}</p><Button onClick={()=>location.reload()}>重新加载</Button></div>:!settings?<Skeleton/>:<>
      <main className="main-content">
        <div className="workspace-page" hidden={page!=='files'}>
          <h1 className="sr-only">文件工作区</h1>
          <div className="toolbar">
            <div className="root-picker">
              <FolderSimple aria-hidden="true"/>
              <select aria-label="工作目录" title={root} value={root} onChange={e=>{setRoot(e.target.value);browseTo([]);}}>
                <option value="" disabled>选择工作目录</option>
                {settings.roots.map(r=><option key={r} value={r}>{basename(r)}</option>)}
              </select>
              <IconButton label="添加工作目录" onClick={()=>void run(addRoot)}><Plus/></IconButton>
            </div>
            <div className="search-field">
              <MagnifyingGlass aria-hidden="true"/>
              <input aria-label="全局搜索" aria-keyshortcuts={ariaShortcut(shortcuts.search)} ref={searchInput} value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索所有工作目录中的文件…"/>
              {query?<IconButton label="清除搜索" onClick={()=>{setQuery('');searchInput.current?.focus();}}><X/></IconButton>:shortcuts.search&&<kbd>{shortcutText(shortcuts.search)}</kbd>}
            </div>
            <DirectoryFilter value={directoryFilter} disabled={!root} onChange={setDirectoryFilter}/>
            <Button className="file-filter-trigger" size="small" aria-expanded={filters} aria-controls={filters?'workspace-file-filters':undefined}
              data-active={!!(filter||extension||after)} icon={<FunnelSimple weight={filters||filter||extension||after?'fill':'regular'} aria-hidden="true"/>}
              onClick={()=>setFilters(v=>!v)}>文件筛选</Button>
            <button type="button" className="index-indicator" onClick={()=>setFilters(v=>!v)} aria-expanded={filters}
              aria-controls={filters?'workspace-file-filters':undefined} title={status.errors.join('\n')||indexLabel}>
              <span className={`status-dot ${status.scanning?'busy':''}`} aria-hidden="true"/><span>{indexLabel}</span>
            </button>
          </div>
          {filters&&<div className="filters" id="workspace-file-filters">
            <label>文件路径包含<input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="可选"/></label>
            <label>扩展名<input value={extension} onChange={e=>setExtension(e.target.value)} placeholder="如 pdf"/></label>
            <label>修改时间起始<input type="date" value={after} onChange={e=>setAfter(e.target.value)}/></label>
            <Button size="small" onClick={()=>void run(()=>api('reindex'))} icon={<ArrowClockwise/>}>重新索引</Button>
            <span>{status.scanning?'正在更新，可继续浏览':indexLabel}{status.errors.length>0&&<details><summary>{status.errors.length} 个目录问题</summary>{status.errors.map((e,i)=><p key={i}>{e}</p>)}</details>}</span>
          </div>}
          <div className="breadcrumb">
            <nav className="breadcrumb-path" aria-label="当前目录路径">
              <button onClick={()=>browseTo([])} title={root} aria-current={root&&!trail.length?'location':undefined}>
                <HardDrives size={16} aria-hidden="true"/><span>{root?basename(root):'尚未添加目录'}</span>
              </button>
              {trail.map((p,i)=><span key={p}>
                <CaretRight size={12} aria-hidden="true"/>
                <button aria-current={i===trail.length-1?'location':undefined} onClick={()=>browseTo(trail.slice(0,i+1))} title={p}><span>{basename(p)}</span></button>
              </span>)}
            </nav>
            <div className="breadcrumb-actions">
              <Button size="small" appearance="subtle" icon={<ArrowCounterClockwise/>} onClick={()=>{preview.close();setRenameHistory(true);}} disabled={!desktop}>改名记录</Button>
              <IconButton label="复制当前路径" disabled={!root} onClick={()=>copyValue(browseDirectory)}><Copy/></IconButton>
              <IconButton label="打开当前目录" disabled={!root} onClick={()=>openDirectory(browseDirectory)}><ArrowSquareOut/></IconButton>
            </div>
          </div>
          {!root?<div className="onboarding"><div className="onboarding-icon"><FolderSimple size={46} weight="thin"/></div><h2>给工作资料一个入口。</h2><p>添加常用目录，保留三级路径同时可见。<br/>所有文件信息都保存在本机。</p><Button appearance="primary" size="large" icon={<Plus/>} onClick={()=>void run(addRoot)}>添加工作目录</Button><button className="text-button" onClick={()=>openSettings('transfer')}>导入配置文件 <ArrowUpRight/></button></div>:<div className={`workspace-grid ${showDeep?'has-deep':'without-deep'}`} ref={workspace} style={{'--left':`${showDeep?storedPercent('--left',75):100}%`,'--top':`${Math.max(30,Math.min(65,storedPercent('--top',36)))}%`} as CSSProperties}>
            <div className="upper-left" ref={columns} style={{'--col-one':`${storedPercent('--col-one',33)}%`,'--col-two':`${storedPercent('--col-two',66)}%`} as CSSProperties}>
              <DirectoryPanel title="第一级目录" parent={root} selected={trail[0]} {...d1} {...directoryProps} onSelect={e=>choose(0,e)}/>
              <DirectoryPanel title="第二级目录" parent={trail[0]||''} selected={trail[1]} {...d2} {...directoryProps} onSelect={e=>choose(1,e)}/>
              <DirectoryPanel title="第三级目录" parent={trail[1]||''} selected={trail[2]} {...d3} {...directoryProps} onSelect={e=>choose(2,e)}/>
              <Splitter axis="x" container={columns} variable="--col-one" min={0} max={100} minPixels={[160,160]} nextVariable="--col-two"/><Splitter axis="x" container={columns} variable="--col-two" min={0} max={100} minPixels={[160,160]} previousVariable="--col-one"/>
            </div>
            {showDeep&&<DirectoryPanel title={trail.length>3?`第${trail.length+1}级目录`:'第四级目录'} parent={deepParent} selected={deepSelected&&samePath(deepSelected.parent,deepParent)?deepSelected.entry.path:undefined} {...d4} {...directoryProps} className="upper-right" onSelect={selectDeep} onEnter={enterDeep} onBack={trail.length>3?()=>browseTo(trail.slice(0,-1)):undefined}/>}
            <section className="file-panel panel" aria-labelledby="workspace-file-heading" onContextMenu={event=>event.preventDefault()}>
              <div className="panel-head">
                <div className="panel-title">
                  <FileText size={16} className="file-heading-icon" aria-hidden="true"/>
                  <h2 id="workspace-file-heading">{q?'搜索结果':'文件列表'}</h2>
                  <span className="count">{resultsReady?files.total:'…'}</span>
                  <span className="file-scope" title={q?scopeLabel:current}>{scopeLabel}</span>
                </div>
                <div className="file-panel-controls">
                  {q&&settings.jevEnabled&&<Button size="small" appearance="subtle" disabled={!!jevTask} icon={<Sparkle/>} onClick={()=>void evaluateJev()}>{jevTask?'正在评分':'JEV 实验评分'}</Button>}
                  <Checkbox size="medium" checked={!!q||recursive} title={q?'搜索始终包含所有工作目录的子文件夹':undefined} disabled={!!q} onChange={(_,d)=>setRecursive(!!d.checked)} label="包含子文件夹"/>
                </div>
              </div>
              {jevResult&&<div className="jev-result"><Check size={14}/>Jev 建议：{jevResult.answers?.intent?.choice||'已评分'}，仅供参考<IconButton label="关闭评分" onClick={()=>setJevResult(null)}><X/></IconButton></div>}
              <div className="file-list" ref={fileList} onWheel={()=>{fileInteraction.current=true;}} onPointerDown={()=>{fileInteraction.current=true;}} onKeyDown={()=>{fileInteraction.current=true;}} onScroll={e=>{if(!fileBusy&&fileInteraction.current)scrollMemory.current.set(fileScope,e.currentTarget.scrollTop);}}>
                {!resultsReady||fileBusy?<Skeleton/>:fileError?<div className="inline-error">{fileError}</div>:!files.items.length?<Empty title={status.scanning?'索引中，稍后显示文件':'没有匹配的文件'} detail={q||f?'试试更短的关键词或清除筛选':'可选择其他目录，或关闭范围限制'}/>:
                  <div style={{height:virtual.getTotalSize(),position:'relative'}}>
                    {virtual.getVirtualItems().map(v=>{
                      const e=files.items[v.index];
                      const isSelected=selectedPaths.has(fileSelectionKey(e));
                      const score=jevResult?.answers?.[`file_${v.index}`]?.score;
                      return <div {...dragProps(e)} className={`file-row ${isSelected?'selected':''}`} data-index={v.index}
                        ref={virtual.measureElement} key={e.path} style={{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${v.start}px)`}}
                        tabIndex={0} role="button" aria-pressed={isSelected} aria-busy={pendingActions.has(openActionKey(e.path))||pendingActions.has(openActionKey(e.path,true))} aria-label={e.name} title={e.path}
                        onPointerEnter={event=>preview.hover(e,event)} onPointerMove={event=>preview.hover(e,event)} onPointerLeave={preview.leave}
                        onClick={event=>selectFile(e,event.ctrlKey)}
                        onDoubleClick={event=>{if(!event.ctrlKey)openEntry(e);}}
                        onContextMenu={event=>{event.preventDefault();preview.close();selectFile(e);openEntry(e,true);}}
                        onKeyDown={event=>{
                          if(event.key==='F2'&&!event.repeat&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();beginRename(e);return;}
                          if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();preview.pin(e,event.currentTarget);return;}
                          if(event.key==='Enter'&&!event.repeat)openEntry(e);
                          if(event.key===' '){event.preventDefault();if(!event.repeat)selectFile(e,event.ctrlKey);}
                        }}>
                        <FileIcon extension={e.extension}/>
                        <div className="file-description">
                          <strong>{e.name}</strong>
                          <span title={e.parent}>{relativePath(e.parent,q?settings.roots.find(r=>isWithin(e.path,r))||root:current)||'当前目录'}</span>
                        </div>
                        <div className="file-meta">
                          <span>{sizeLabel(e.size)}</span>
                          <span>{new Date(e.modified*1000).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'})}</span>
                        </div>
                        {jevResult&&<span className="file-score">{score!=null&&<span className="score" title="仅根据名称与相对路径评分">{score.toFixed(1)}</span>}</span>}
                      </div>;
                    })}
                  </div>}
              </div>
              <div className="file-actions">
                <span className="file-action-label" title={selectedFile?.name} aria-live="polite">
                  {multipleSelected?<><strong>已选 {selectedFiles.length} 个文件</strong>{ocrPaths.length<selectedFiles.length&&` · ${ocrPaths.length} 个可送入 OCR`}</>
                    :selectedFile?.name??'Ctrl＋单击多选 · Ctrl 悬停预览 · 双击打开 · 右键打开所在文件夹'}
                </span>
                {selectedFiles.length>0&&<div className="file-action-buttons" role="group" aria-label="所选文件操作">
                  {selectedFile&&<>
                    <Button size="small" appearance="subtle" icon={<PencilSimple/>} onClick={()=>beginRename(selectedFile)}>重命名</Button>
                    <IconButton label="复制文件名称" onClick={()=>copyValue(selectedFile.name)}><FileText/></IconButton>
                    <IconButton label="复制文件路径" onClick={()=>copyValue(selectedFile.path)}><Copy/></IconButton>
                    <Button size="small" onClick={event=>preview.pin(selectedFile,event.currentTarget)}>预览文件</Button>
                    <IconButton label="打开文件" disabled={pendingActions.has(openActionKey(selectedFile.path))} onClick={()=>openEntry(selectedFile)}><ArrowSquareOut/></IconButton>
                    <IconButton label="打开所在文件夹" disabled={pendingActions.has(openActionKey(selectedFile.path,true))} onClick={()=>{preview.close();openEntry(selectedFile,true);}}><FolderSimple/></IconButton>
                    <Button size="small" appearance="subtle" onClick={()=>locate(selectedFile)}>工作区定位</Button>
                  </>}
                  {multipleSelected&&<Button size="small" appearance="subtle" onClick={()=>setSelectedPaths(new Set())}>清除选择</Button>}
                  {(multipleSelected||ocrPaths.length>0)&&<Button size="small" appearance={multipleSelected?'primary':'subtle'} disabled={!ocrPaths.length} onClick={()=>{
                    setOcrIncoming(pending=>[...new Set([...pending,...ocrPaths])]);
                    setPage('ocr');
                  }}>送入 OCR</Button>}
                </div>}
                {resultsReady&&files.total>100&&<div className="pagination" role="group" aria-label="文件列表分页">
                  <IconButton label="上一页" disabled={!offset} onClick={()=>setOffset(x=>Math.max(0,x-100))}><ArrowLeft/></IconButton>
                  <span>{Math.floor(offset/100)+1}/{Math.ceil(files.total/100)}</span>
                  <IconButton label="下一页" disabled={offset+100>=files.total} onClick={()=>setOffset(x=>x+100)}><ArrowRight/></IconButton>
                </div>}
              </div>
            </section>
            {showDeep&&<Splitter axis="x" container={workspace} variable="--left" min={0} max={100} minPixels={[500,160]}/>}<Splitter axis="y" container={workspace} variable="--top" min={30} max={65}/>
          </div>}
        </div>
        <div className="tools-page" hidden={page!=='tools'}><ToolsWorkbench launchers={settings.launchers} pendingActions={pendingActions} onLaunch={id=>launchTool(id)} onOpenFolder={id=>launchTool(id,true)} onCopyPath={copyValue} onOpenSettings={tab=>openSettings(tab||'tools')}/></div>
        {(ocrVisited||page==='ocr')&&<Suspense fallback={<Skeleton/>}><OcrWorkbench visible={page==='ocr'} incoming={ocrIncoming} onDiagnose={request=>{setDiagnosticRequest(request);setAssistant(true);}} onConsumed={done=>setOcrIncoming(current=>current.filter(path=>!done.includes(path)))} onSettings={()=>openSettings('integrations')}/></Suspense>}
        {(todoVisited||page==='todo')&&<Suspense fallback={<Skeleton/>}><TodoWorkbench visible={page==='todo'} reminderRequest={todoReminder}/></Suspense>}
      </main>
      <footer className="statusbar"><span><span className="status-dot"/>本地工作台</span><span>{root?basename(root):'添加目录即可开始'}<span className="status-divider"/>{status.scanning?'正在同步索引':'文件信息保存在本机'}</span><span className="statusbar-right"><button onClick={()=>setQuick(true)} title={quickShortcutHint}>快捷面板 {shortcuts.quick&&<kbd>{shortcutText(shortcuts.quick)}</kbd>}</button><IconButton label={dark?'切换浅色':'切换深色'} onClick={()=>void run(async()=>saved(await api<Settings>('save_settings',{next:{...settings,theme:dark?'light':'dark'}})))}>{dark?<Sun/>:<Moon/>}</IconButton></span></footer>
      <Suspense fallback={null}><Assistant diagnosticRequest={diagnosticRequest} onDiagnosticConsumed={()=>setDiagnosticRequest(null)} onWorkspaceSettings={()=>openSettings('assistant')} settings={settings} onPricingSettings={()=>openSettings('pricing')} onLocate={path=>{const found=settings.roots.find(r=>isWithin(path,r));if(!found){void run(()=>api('open_path',{path,reveal:false}));return;}setRoot(found);setTrail(locateTrail(found,path));setQuery('');setPage('files');setAssistant(false);}} open={assistant} onClose={()=>setAssistant(false)} context={viewContext} onProposal={p=>{setProposal(p);setProposalError('');}}/></Suspense>
      {renameEntry&&<WorkspaceRenameDialog key={renameEntry.path} entry={renameEntry} onChanged={renamed} onClose={()=>setRenameEntry(null)}/>}
      {renameHistory&&<WorkspaceRenameHistory onChanged={renamed} onClose={()=>setRenameHistory(false)}/>}
      {about&&<AboutView onClose={()=>setAbout(false)}/>}
      <SetupWizard settings={settings} onSaved={saved} onAddRoot={addRoot}/>
      {settingsTab&&<SettingsView settings={settings} initialTab={settingsTab} globalShortcutActive={globalShortcutActive} onSaved={saved} onClose={()=>setSettingsTab(null)}/>}
      {proposal&&<Modal title={hasPricingChange(proposal)?'确认计价调整':'确认配置变更'} onClose={()=>{if(!proposalBusy)setProposal(null);}} wide><p className="proposal-confirm-hint">{hasPricingChange(proposal)?'检查下方调整建议。确认后用于下一次任务，历史费用保留原单价。':'检查下方调整建议，确认后应用。'}</p><ProposalDiff proposal={proposal}/>{proposalError&&<p className="inline-error" role="alert">{proposalError}</p>}<div className="dialog-actions"><span>需要你的确认才会生效</span><Button disabled={proposalBusy} onClick={()=>{setProposalBusy(true);void api('decide_proposal',{id:proposal.id,approve:false}).then(()=>setProposal(null)).catch(e=>setProposalError(String(e))).finally(()=>setProposalBusy(false));}}>不应用</Button><Button disabled={proposalBusy} appearance="primary" onClick={()=>{setProposalBusy(true);void api<Settings>('decide_proposal',{id:proposal.id,approve:true}).then(s=>{saved(s);setProposal(null);setNotice('配置已更新');}).catch(e=>setProposalError(String(e))).finally(()=>setProposalBusy(false));}}>{proposalBusy?'正在处理…':'确认并应用'}</Button></div></Modal>}
       {quick&&<QuickPanel roots={settings.roots} launchers={settings.launchers} history={recent.items} historyError={recent.error} onRemove={recent.remove} onClear={recent.clear} onLocate={locatePath} onLaunch={launchTool} onClose={()=>setQuick(false)}/>}
    </>}
    {preview.target&&<FilePreview key={preview.target.entry.path} target={preview.target} request={preview.request} generation={status.generation} onClose={preview.close} onPin={preview.pinPanel} onEnter={preview.enterPanel} onLeave={preview.leavePanel} onOpen={openEntry}/>}
    {notice&&<div className="toast" role="status">{notice}<IconButton label="关闭提示" onClick={()=>setNotice('')}><X/></IconButton></div>}
    <NetworkConsent/>
  </IconContext.Provider></FluentProvider>;
}


