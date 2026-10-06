import type { Activity } from './types';
import { ArrowUpRight, CaretDown, BookOpen } from '@phosphor-icons/react';
import { AssistantMarkdown } from './AssistantMarkdown';
import { type Link, webLink } from './assistantState';
const names:Record<string,string>={files_query:'查询目录信息',files_analyze:'分析业务文件',resultset_enrich:'补充原结果字段',directory_tree:'获取目录结构',task_clarify:'等待补充条件',web_search:'联网搜索',files_search:'搜索本地文件',files_list_dirs:'浏览目录',files_missing_companion:'核对配套文件',report_create:'生成报告',app_get_state:'查看工作台状态',settings_read:'读取设置',settings_propose_change:'提出设置变更',text_translate:'翻译文本',files_reveal:'定位文件',path_open:'打开路径',launcher_run:'启动工具',index_refresh:'刷新索引',clipboard_copy:'复制文本'};
const statuses={running:'进行中',completed:'已完成',failed:'失败',interrupted:'已中断'};
export function AssistantActivity({items,onLink,scope,expanded,onToggle}:{items:Activity[];onLink:(l:Link)=>void;scope:string;expanded:Record<string,boolean>;onToggle:(key:string,open:boolean)=>void}){
  if(!items.length)return null;
  return <div className="assistant-activities" aria-label="思考与执行过程">{items.map((item,i)=><details key={item.id} open={!!expanded[scope+':'+item.id]} onToggle={e=>{const key=scope+':'+item.id;if(e.currentTarget.open!==!!expanded[key])onToggle(key,e.currentTarget.open);}} className={`activity activity-${item.status}`}>
    <summary><span className="activity-index">{i+1}</span><span>{item.kind==='reasoning'?'思考内容':item.kind==='note'?'处理说明':names[item.tool||'']||item.tool}</span><span className="activity-status">{statuses[item.status]}{item.elapsedMs!==undefined?` · ${(item.elapsedMs/1000).toFixed(1)} 秒`:''}</span></summary>
    {!!expanded[scope+':'+item.id]&&<div className="activity-body">{item.kind==='reasoning'&&<><p className="activity-hint">模型服务返回的思考内容</p><pre className="activity-reasoning-text">{item.text}</pre></>}{item.kind==='note'&&item.text&&<AssistantMarkdown text={item.text} onLink={onLink}/>}{item.kind==='tool'&&<>
      {item.args!==undefined&&<><strong>执行参数</strong><pre>{JSON.stringify(item.args,null,2)}</pre></>}
      {item.result!==undefined&&<><strong>执行结果</strong><pre>{JSON.stringify(item.result,null,2)}</pre></>}
      {item.status==='running'&&<p>正在等待工具结果…</p>}
    </>}</div>}
  </details>)}</div>;
}
export function SearchSources({links,onLink,onToggle}:{links:Link[];onLink:(l:Link)=>void;onToggle:()=>void}){
  const sources=links.filter(l=>l.kind==='web'&&webLink(l.target));
  return sources.length?<details className="assistant-sources" aria-label="搜索来源" onToggle={onToggle}>
    <summary className="assistant-sources-header"><BookOpen size={15}/><strong>参考来源</strong><span className="source-count">{sources.length} 条</span><CaretDown className="source-chevron" size={14}/></summary>
    <ol className="assistant-sources-list">
      {sources.map((link,i)=><li key={link.target}><a href={link.target} title={link.label} target="_blank" rel="noreferrer noopener" onClick={e=>{e.preventDefault();onLink(link);}}>
        <span className="source-num" aria-hidden="true">{i+1}</span>
        <span className="source-description"><span className="source-title">{link.label}</span><span className="source-host">{new URL(link.target).hostname}</span></span>
        <ArrowUpRight className="source-open-icon" size={14} aria-hidden="true"/>
      </a></li>)}
    </ol>
  </details>:null;
}
