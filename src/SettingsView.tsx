import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Switch, Tab, TabList } from '@fluentui/react-components';
import { Plus, Trash, FolderOpen, ArrowUp, ArrowDown, Key, UploadSimple, DownloadSimple } from '@phosphor-icons/react';
import type { Settings, Launcher } from './types';
import { api, desktop, pick } from './api';
import { IconButton, Modal } from './components';
import { ReasoningSelect } from './ReasoningSelect';
import { AssistantDocuments } from './AssistantDocuments';
import { basename } from './domain';
import { workspaceKey } from './assistantState';
import { getLauncherVisual } from './launcherVisuals';

const modules = [
  {id:'workspace',label:'工作台',description:'设置文件搜索范围、外观和默认浏览方式。',keys:['roots','theme','recursive','filter']},
  {id:'tools',label:'常用工具',description:'整理每天需要打开的程序、文件、快捷方式和网页入口。',keys:['launchers']},
  {id:'model',label:'模型参数',description:'配置连接、回复、思考和等待时间。新参数在下一次任务生效。',keys:['modelUrl','modelId','assistantReasoning','translationReasoning','modelContextTokens','assistantOutputTokens','translationOutputTokens','modelRequestTimeoutSecs','modelFirstResponseTimeoutSecs','modelIdleTimeoutSecs','modelRetryCount','assistantTaskTimeoutSecs','assistantHistoryMessages','assistantHistoryChars','assistantToolRounds','assistantSearchLimit','assistantAutoContinue','assistantContinueTokens','modelTemperature','modelTopP']},
  {id:'assistant',label:'助理配置',description:'设置新会话的报告目录，以及助手的表达方式和工作规范。',keys:[]},
  {id:'integrations',label:'联网与评分',description:'按需启用公开资料搜索和候选评分，并管理各自密钥。',keys:['tavilyEnabled','jevEnabled']},
  {id:'transfer',label:'导入导出',description:'导出已保存的配置，或导入配置文件并确认应用。',keys:[]},
] as const;
export type ModuleId=typeof modules[number]['id'];
type NumberKey='modelContextTokens'|'assistantOutputTokens'|'translationOutputTokens'|'modelFirstResponseTimeoutSecs'|'modelIdleTimeoutSecs'|'modelRequestTimeoutSecs'|'modelRetryCount'|'assistantTaskTimeoutSecs'|'assistantHistoryMessages'|'assistantHistoryChars'|'assistantToolRounds'|'assistantSearchLimit'|'assistantContinueTokens';
function readWorkspace(){try{return localStorage.getItem(workspaceKey)||'';}catch{return '';}}

export function SettingsView({settings,onSaved,onClose,initialTab='workspace'}:{settings:Settings;onSaved:(s:Settings)=>void;onClose:()=>void;initialTab?:ModuleId}) {
  const [draft,setDraft]=useState(()=>structuredClone(settings)),[tab,setTab]=useState<ModuleId>(initialTab);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[secret,setSecret]=useState(''),[provider,setProvider]=useState(initialTab==='integrations'?'tavily':'model'),[message,setMessage]=useState('');
  const [closing,setClosing]=useState(false),[roleDirty,setRoleDirty]=useState(false);
  const [pendingSecretAction,setPendingSecretAction]=useState<(()=>void)|null>(null);
  const closeWarning=useRef<HTMLDivElement>(null);
  function revealCloseWarning(){closeWarning.current?.scrollIntoView({block:'center'});closeWarning.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});}
  useEffect(()=>{if(closing||pendingSecretAction)revealCloseWarning();},[closing,pendingSecretAction]);
  const [workspace,setWorkspace]=useState(readWorkspace),[savedWorkspace,setSavedWorkspace]=useState(readWorkspace);
  const [imported,setImported]=useState<Settings|null>(null);
  const module=modules.find(m=>m.id===tab)!;
  const dirtyModules=modules.filter(m=>m.keys.some(key=>JSON.stringify(draft[key as keyof Settings])!==JSON.stringify(settings[key as keyof Settings]))||(m.id==='assistant'&&(workspace!==savedWorkspace||roleDirty))||(m.id==='transfer'&&imported!==null));
  function requestClose(){if(busy)return;setPendingSecretAction(null);if(dirtyModules.length||secret.trim()){if(closing)revealCloseWarning();else setClosing(true);}else onClose();}
  const dirty=dirtyModules.some(m=>m.id===tab);
  const change=<K extends keyof Settings>(key:K,value:Settings[K])=>setDraft(d=>({...d,[key]:value}));
  const run=async(fn:()=>Promise<void>)=>{setError('');setMessage('');setBusy(true);try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}};
  function guardSecret(action:()=>void){if(secret.trim()){setClosing(false);setPendingSecretAction(()=>action);}else action();}
  function switchTab(next:ModuleId){if(next===tab)return;guardSecret(()=>{setClosing(false);setTab(next);setError('');setMessage('');setSecret('');setProvider(next==='integrations'?'tavily':'model');});}
  async function addRoot(){const path=await pick(true);if(path&&!draft.roots.includes(path))change('roots',[...draft.roots,path]);}
  async function addLauncher(){const path=await pick(false);if(path)change('launchers',[...draft.launchers,{id:crypto.randomUUID(),name:basename(path),path,group:'常用工具'}]);}
  function addWebLauncher(){change('launchers',[...draft.launchers,{id:crypto.randomUUID(),name:'',path:'https://',group:'网页入口'}]);}
  function editLauncher(index:number,field:keyof Launcher,value:string){change('launchers',draft.launchers.map((l,i)=>i===index?{...l,[field]:value}:l));}
  function move(index:number,delta:number){const next=[...draft.launchers];[next[index],next[index+delta]]=[next[index+delta],next[index]];change('launchers',next);}
  function numberField(key:NumberKey,label:string,fallback:number,min:number,max:number,hint:string){return <label>{label}<input aria-label={label} aria-describedby={'settings-hint-'+key} type="number" min={min} max={max} step={1} required value={draft[key]??fallback} onChange={e=>change(key,e.target.value===''?NaN:Number(e.target.value))}/><small id={'settings-hint-'+key}>{hint}</small></label>;}
  async function saveModule(event:FormEvent<HTMLFormElement>){event.preventDefault();
    if(busy||(tab==='assistant'?workspace===savedWorkspace:!dirty))return;
    const panel=event.currentTarget.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    for(const field of panel?.querySelectorAll<HTMLInputElement>('input,select')||[]){if(!field.checkValidity()){const details=field.closest('details');if(details)details.open=true;field.reportValidity();return;}}
    await run(async()=>{
      if(tab==='assistant'){if(workspace)await api('assistant_workspace',{path:workspace});localStorage.setItem(workspaceKey,workspace);setSavedWorkspace(workspace);setMessage('报告目录已保存，新建会话时生效。');return;}
      if(tab==='transfer'){
        if(!imported)return;
        const saved=await api<Settings>('save_settings',{next:{...imported,revision:settings.revision}});onSaved(saved);
        setDraft(structuredClone(saved));setImported(null);setMessage('配置已导入。');return;
      }
      const keys:readonly string[]=module.keys;
      const next={...settings};for(const key of keys)Object.assign(next,{[key]:draft[key as keyof Settings]});
      const saved=await api<Settings>('save_settings',{next});onSaved(saved);
      setDraft(previous=>{const merged={...previous,revision:saved.revision};for(const key of keys)Object.assign(merged,{[key]:saved[key as keyof Settings]});return merged;});
      setMessage(module.label+'已保存，其他模块的草稿继续保留。');
    });
  }
  function resetModule(){if(tab==='transfer'){setImported(null);setError('');setMessage('已取消本次导入。');return;}if(tab==='assistant'){setWorkspace(savedWorkspace);return;}setDraft(old=>{const next={...old};for(const key of module.keys)Object.assign(next,{[key]:settings[key as keyof Settings]});return next;});setError('');setMessage('本模块已恢复为已保存的配置。');}
  async function exportSettings(){if(!desktop)throw new Error('配置导入导出需要运行桌面版');const {save}=await import('@tauri-apps/plugin-dialog');const path=await save({defaultPath:'office-next-settings.json',filters:[{name:'JSON 配置',extensions:['json']}]});if(!path)return;await api('export_settings',{path});setMessage('已导出配置：'+path);}
  async function importSettings(){if(!desktop)throw new Error('配置导入导出需要运行桌面版');const {open}=await import('@tauri-apps/plugin-dialog');const path=await open({multiple:false,filters:[{name:'JSON 配置',extensions:['json']}]});if(!path)return;setImported(null);const next=await api<Settings>('import_settings',{path});setImported(next);setMessage('配置已校验，请检查后点击“确认导入配置”。');}
  const deepseek=(()=>{try{return new URL(draft.modelUrl).hostname==='api.deepseek.com';}catch{return false;}})();
  function preset(deep:boolean){setDraft(d=>({...d,assistantReasoning:deep?'high':'default',assistantOutputTokens:deep?0:8192,assistantToolRounds:deep?18:10,assistantSearchLimit:deep?8:4,assistantHistoryMessages:12,assistantHistoryChars:deep?6000:4000,assistantAutoContinue:true,assistantContinueTokens:deep?16384:8192}));setMessage((deep?'复杂任务':'日常办公')+'配置已填入草稿，保存此模块后生效。');}
  return <Modal title="工作台设置" onClose={requestClose} wide>
    <form className="settings-form" noValidate onSubmit={e=>void saveModule(e)}>
      <TabList className="settings-tabs" selectedValue={tab} onTabSelect={(_,data)=>switchTab(data.value as ModuleId)} aria-label="设置模块" disabled={busy}>
        {modules.map(m=>{const unsaved=dirtyModules.some(d=>d.id===m.id);return <Tab id={'settings-tab-'+m.id} key={m.id} value={m.id} aria-label={m.label} aria-controls={'settings-panel-'+m.id} aria-describedby={unsaved?'settings-unsaved-'+m.id:undefined}>{m.label}{unsaved&&<><span className="settings-dirty-dot" aria-hidden="true"/><span id={'settings-unsaved-'+m.id} className="sr-only">有未保存修改</span></>}</Tab>;})}
      </TabList>
      {closing&&<div ref={closeWarning} className="settings-close-warning" role="alert"><p>还有未保存的修改。已保存的设置、密钥和角色文件会保留。{secret.trim()&&'未保存的密钥输入将被清空。'}</p><div className="button-row"><Button type="button" onClick={()=>setClosing(false)}>继续配置</Button><Button type="button" onClick={onClose}>放弃未保存修改并关闭</Button></div></div>}
      {pendingSecretAction&&<div ref={closeWarning} className="settings-close-warning" role="alert"><p>切换设置页或密钥服务会清空未保存的密钥输入。</p><div className="button-row"><Button type="button" onClick={()=>setPendingSecretAction(null)}>保留密钥输入</Button><Button type="button" onClick={()=>{const action=pendingSecretAction;setPendingSecretAction(null);action();}}>放弃密钥输入并继续</Button></div></div>}
      <div className="settings-module-heading"><div><h3>{module.label}</h3><p>{module.description}</p></div><span>{dirty?'未保存修改':'已保存配置'}</span></div>
      <fieldset className="settings-content" disabled={busy}><div className="settings-panels">
        <div id="settings-panel-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace" hidden={tab!=='workspace'}>
          <section className="settings-section"><h3>文件搜索范围</h3><p>只索引目录下的文件信息，不读取文档正文。</p>
            <div className="root-list">{draft.roots.map((root,i)=><div key={root}><FolderOpen/><span title={root}>{root}</span><IconButton label="移除此目录" onClick={()=>change('roots',draft.roots.filter((_,j)=>i!==j))}><Trash/></IconButton></div>)}</div>
            {!draft.roots.length&&<p className="settings-empty">还没有搜索目录，添加文件夹后即可建立本地索引。</p>}<Button icon={<Plus/>} onClick={()=>void run(addRoot)}>添加目录</Button>
          </section>
          <section className="settings-section"><h3>外观与浏览</h3><div className="form-grid"><label>主题<select value={draft.theme} onChange={e=>change('theme',e.target.value as Settings['theme'])}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><label>默认文件筛选<input value={draft.filter} onChange={e=>change('filter',e.target.value)} placeholder="文件名或后缀"/></label></div><Switch checked={draft.recursive} onChange={(_,d)=>change('recursive',d.checked)} label="默认包含子文件夹"/></section>
        </div>
        <div id="settings-panel-tools" role="tabpanel" aria-labelledby="settings-tab-tools" hidden={tab!=='tools'}>
          <section className="settings-section"><h3>快捷启动列表</h3><p>按这里的顺序展示，程序启动由你手动触发。系统会自动识别工具类型与格式。</p>
            {draft.launchers.map((l,i)=>{
              const visual=getLauncherVisual(l);
              const IconComp=visual.icon;
              return <div className="launcher-editor" key={l.id}>
                <div className="launcher-editor-preview" style={{color:visual.theme.primary,backgroundColor:visual.theme.subtle,borderColor:visual.theme.border}} title={`识别为：${visual.label} (${visual.badge})`}>
                  <IconComp size={16} weight="duotone"/>
                  <span>{visual.badge}</span>
                </div>
                <label>名称<input required value={l.name} onChange={e=>editLauncher(i,'name',e.target.value)}/></label>
                <label>分组<input value={l.group} onChange={e=>editLauncher(i,'group',e.target.value)}/></label>
                <label className="target-input">目标路径或网址<input required value={l.path} onChange={e=>editLauncher(i,'path',e.target.value)}/></label>
                <IconButton label="上移" disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp/></IconButton>
                <IconButton label="下移" disabled={i===draft.launchers.length-1} onClick={()=>move(i,1)}><ArrowDown/></IconButton>
                <IconButton label="删除工具" onClick={()=>change('launchers',draft.launchers.filter((_,j)=>j!==i))}><Trash/></IconButton>
              </div>;
            })}
            {!draft.launchers.length&&<p className="settings-empty">把常用程序、文件、快捷方式或网页加入列表。</p>}<Button icon={<Plus/>} onClick={()=>void run(addLauncher)}>添加工具</Button><Button type="button" icon={<Plus/>} onClick={addWebLauncher}>添加网页入口</Button>
          </section>
        </div>
        <div id="settings-panel-model" role="tabpanel" aria-labelledby="settings-tab-model" hidden={tab!=='model'}>
          <section className="settings-section"><h3>连接模型服务</h3><p>使用兼容的聊天接口。服务地址和模型名称由你的模型服务提供。</p>
            <div className="form-grid"><label>服务地址<input type="url" value={draft.modelUrl} onChange={e=>change('modelUrl',e.target.value)} placeholder="https://你的服务/v1"/></label><label>模型 ID<input value={draft.modelId} onChange={e=>change('modelId',e.target.value)} placeholder="例如 deepseek-flash"/></label></div>
            <div className="button-row"><Button type="button" disabled={busy||!draft.modelUrl.trim()||!draft.modelId.trim()} onClick={()=>void run(async()=>{const result=await api<{model:string;elapsedMs:number}>('model_test',{modelUrl:draft.modelUrl,modelId:draft.modelId});setMessage('连接正常：'+(result.model||draft.modelId)+'。已使用系统中保存的密钥，连接草稿尚未保存。');})}>测试连接</Button><small>主动发送一条简短测试消息，使用系统中已保存的密钥。</small></div>
          </section>
          <section className="settings-section"><h3>按任务选择配置</h3><p>选择后先填入草稿，检查并保存。连接地址、密钥和等待时间保持当前设置。</p><div className="button-row"><Button type="button" onClick={()=>preset(false)}>日常办公</Button><Button type="button" onClick={()=>preset(true)}>复杂任务</Button></div><p>日常办公适合问答和文件整理；复杂任务增加思考、历史和操作预算。</p></section>
          <section className="settings-section"><h3>回复与思考</h3><div className="form-grid"><ReasoningSelect label="助手思考程度" value={draft.assistantReasoning||'default'} onChange={v=>change('assistantReasoning',v)}/><ReasoningSelect label="翻译思考程度" value={draft.translationReasoning||'default'} onChange={v=>change('translationReasoning',v)}/>
            {numberField('assistantOutputTokens','助手输出上限',0,0,384000,'0 自动选择；深度求索 65536，其他服务 8192。')}
            {numberField('translationOutputTokens','翻译输出上限',0,0,384000,'0 使用服务默认。此上限用于每个翻译分段。')}
          </div><p>输出上限以标记数计，思考和正文可能共用额度。填写的值还需符合所选模型的限制。</p></section>
          <section className="settings-section"><h3>等待与恢复</h3><div className="form-grid">
            {numberField('modelRequestTimeoutSecs','单次请求等待（秒）',300,10,600,'单次请求总预算；持续输出也不能超过这个上限。')}
            {numberField('modelFirstResponseTimeoutSecs','首响应等待（秒）',45,10,600,'等待首段思考、正文或工具参数；连接等待另限10秒。')}
            {numberField('modelIdleTimeoutSecs','输出停滞等待（秒）',60,10,600,'持续有效输出会重新计时，心跳不会延长等待。')}
            {numberField('assistantTaskTimeoutSecs','助手任务等待（秒）',600,30,1800,'整个任务的上限，应不小于单次请求等待。')}
            {numberField('modelRetryCount','服务繁忙重试次数',2,0,2,'仅对短暂连接失败、限流或繁忙重试；0 不重试。')}
            {numberField('assistantContinueTokens','截断后补写上限',16384,256,384000,'自动补写仅收尾，不再执行工具。')}
          </div><Switch checked={draft.assistantAutoContinue??true} onChange={(_,d)=>change('assistantAutoContinue',d.checked)} label="回复截断后自动补写一次"/></section>
          <section className="settings-section"><div className="settings-budget-heading"><h3>上下文与工具预算</h3><Button type="button" size="small" onClick={()=>{setDraft(d=>({...d,assistantReasoning:'none',assistantOutputTokens:8192,assistantToolRounds:6,assistantSearchLimit:3,assistantHistoryMessages:6,assistantHistoryChars:2000,assistantAutoContinue:true,assistantContinueTokens:4096}));setMessage('高效配置已填入草稿，点击“保存此模块”后生效。');}}>使用高效配置</Button></div><p>适合检索、计数和日常问答：关闭长思考，最多六轮、三次联网检索；复杂任务仍可手动调整。</p><div className="form-grid">
            {numberField('modelContextTokens','模型上下文容量',0,0,10000000,'用于底栏占用率；0 自动识别 DeepSeek Flash / V4 为 1000000，其他模型显示未知。可按服务实际规格填写。')}
            {numberField('assistantHistoryMessages','发送历史消息条数',12,0,12,'0 不发送聊天历史，最多最近 12 条。')}
            {numberField('assistantHistoryChars','每条历史文字上限',4000,500,12000,'只影响发送给模型的历史，保留本机完整记录。')}
            {numberField('assistantToolRounds','任务模型轮数上限',25,1,25,'包含最后汇报的一轮；1 只回复，不调用工具。')}
            {numberField('assistantSearchLimit','任务联网搜索次数上限',8,0,20,'0 禁用联网工具；已有资料仍可用于汇报。')}
          </div><p>历史思考内容留在本机；已收集的工具资料摘要单独传递。调整这些参数不会扩大文件访问权限。</p></section>
          <details className="settings-advanced"><summary>高级采样参数</summary><p>留空使用模型默认；不同服务对这些参数的支持不同。</p><div className="form-grid">
            <label>随机程度<input type="number" min={0} max={2} step={0.1} value={draft.modelTemperature??''} onChange={e=>change('modelTemperature',e.target.value===''?null:Number(e.target.value))} placeholder="模型默认"/><small>较低时表达更稳定，较高时措辞更多样。</small></label>
            <label>采样范围<input type="number" min={0.01} max={1} step={0.01} value={draft.modelTopP??''} onChange={e=>change('modelTopP',e.target.value===''?null:Number(e.target.value))} placeholder="模型默认"/><small>通常保留默认，只调整一个采样参数。</small></label>
          </div>{deepseek&&<p>深度求索开启思考时不发送随机程度；关闭思考后生效。采样范围按模型自身规则处理。</p>}</details>
        </div>
        <div id="settings-panel-assistant" role="tabpanel" aria-labelledby="settings-tab-assistant" hidden={tab!=='assistant'}>
          <section className="settings-section"><h3>新会话的报告目录</h3><p>用于助手生成的文件核对报告。每个会话仍可另选目录。</p><div className="settings-workspace-path">{workspace||'应用数据目录中的默认报告文件夹'}</div><div className="button-row"><Button onClick={()=>void run(async()=>{const path=await pick(true);if(path)setWorkspace(path);})}>选择报告文件夹</Button><Button onClick={()=>setWorkspace('')}>使用应用默认目录</Button><Button onClick={()=>void run(async()=>{await api('assistant_workspace',{path:workspace||null,open:true});})}>打开报告目录</Button></div><p>保存此模块后，新建会话使用此目录。已有会话和报告不移动。</p></section>
          <AssistantDocuments onDirtyChange={setRoleDirty}/>
        </div>
        <div id="settings-panel-integrations" role="tabpanel" aria-labelledby="settings-tab-integrations" hidden={tab!=='integrations'}>
          <section className="settings-section"><h3>公开资料搜索</h3><Switch checked={!!draft.tavilyEnabled} onChange={(_,d)=>change('tavilyEnabled',d.checked)} label="启用 Tavily 联网搜索"/><p>主动提问时按需搜索。公开搜索词发给搜索服务，结果摘要发给模型。</p></section>
          <section className="settings-section"><h3>候选评分</h3><Switch checked={draft.jevEnabled} onChange={(_,d)=>change('jevEnabled',d.checked)} label="启用 Jev 实验建议与候选评分"/><p>使用前 20 条名称和相对路径进行实验评分；精确日期和缺失核对仍使用本地规则。</p></section>
        </div>
        <div id="settings-panel-transfer" role="tabpanel" aria-labelledby="settings-tab-transfer" hidden={tab!=='transfer'}>
          <section className="settings-section"><h3>导出当前配置</h3><p>导出已保存的搜索目录、常用工具、外观、模型参数和联网开关。API 密钥、助理角色文件、报告目录和业务记录不包含在内。</p><Button type="button" icon={<DownloadSimple/>} onClick={()=>void run(exportSettings)}>导出配置</Button></section>
          <section className="settings-section"><h3>导入配置文件</h3><p>选择本应用导出的 JSON 配置文件。确认后将替换工作台、常用工具、模型参数与联网设置，并清除这些模块中未保存的草稿。</p><Button type="button" icon={<UploadSimple/>} onClick={()=>void run(importSettings)}>选择配置文件</Button>
            {imported&&<><p>待导入：{imported.roots.length} 个搜索目录、{imported.launchers.length} 个常用工具；模型：{imported.modelId||'未配置'}。</p><details className="settings-advanced"><summary>查看待导入的完整配置</summary><pre>{JSON.stringify(imported,null,2)}</pre></details></>}
          </section>
        </div>
      </div>
      {(tab==='model'||tab==='integrations')&&<section className="settings-section settings-credentials"><h3>服务密钥</h3><p>密钥单独保存到系统凭据管理器，保存模块时不会提交密钥。</p><div className="credential-form"><label>密钥服务<select value={provider} disabled={busy} onChange={e=>{const next=e.target.value;guardSecret(()=>{setProvider(next);setSecret('');});}}>{tab==='model'?<option value="model">生成模型</option>:<><option value="tavily">Tavily 联网搜索</option><option value="jev">TypeSafe / Jev</option></>}</select></label><label>API 密钥<input type="password" autoComplete="off" disabled={busy} value={secret} onChange={e=>setSecret(e.target.value)} placeholder="保存在系统凭据管理器"/></label><Button icon={<Key/>} disabled={!secret||busy} onClick={()=>void run(async()=>{await api('set_key',{provider,secret});setSecret('');setMessage('密钥已保存到系统凭据管理器');})}>保存密钥</Button><Button disabled={busy} onClick={()=>void run(async()=>{await api('set_key',{provider,secret:''});setMessage('密钥已删除');})}>清除密钥</Button></div></section>}
      </fieldset>{message&&<p className="notice" role="status">{message}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}
      <footer className="dialog-actions settings-actions"><span>{dirtyModules.length?dirtyModules.length+' 个模块有未保存修改':'配置已保存'}<small>配置版本 {settings.revision}</small></span><Button onClick={requestClose} disabled={busy}>关闭</Button><Button disabled={busy||(tab==='assistant'?workspace===savedWorkspace:!dirty)} onClick={resetModule}>{tab==='transfer'?'取消本次导入':tab==='assistant'?'撤销目录修改':'撤销本模块修改'}</Button><Button appearance="primary" type="submit" disabled={busy||(tab==='assistant'?workspace===savedWorkspace:!dirty)}>{busy?'正在保存…':tab==='transfer'?'确认导入配置':tab==='assistant'?'保存报告目录':'保存此模块'}</Button></footer>
    </form>
  </Modal>;
}
