import { useRef } from 'react';
import { FunnelSimple, X } from '@phosphor-icons/react';
import { IconButton } from './components';

export function DirectoryFilter({value,disabled,onChange}:{value:string;disabled:boolean;onChange:(value:string)=>void}) {
  const input=useRef<HTMLInputElement>(null);
  return <div className={`directory-filter ${value.trim()?'is-active':''}`}>
    <div className="filter-field">
      <FunnelSimple aria-hidden="true"/>
      <label htmlFor="directory-filter-input">目录筛选</label>
      <input id="directory-filter-input" ref={input} disabled={disabled} value={value} onChange={event=>onChange(event.target.value)} placeholder="输入目录名称…" aria-describedby="directory-filter-hint"/>
      <span className="directory-filter-clear">{value&&<IconButton label="清除目录筛选" disabled={disabled} onClick={()=>{onChange('');input.current?.focus();}}><X/></IconButton>}</span>
    </div>
    <span id="directory-filter-hint" className="sr-only">只筛选当前各级目录列表，每级范围取自前一级已选目录；已选路径保留，文件列表不受筛选词影响。</span>
  </div>;
}
