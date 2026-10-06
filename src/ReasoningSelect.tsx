import type { ReasoningEffort } from './types';
export function ReasoningSelect({label,value,onChange,disabled=false}:{label:string;value:ReasoningEffort;onChange:(value:ReasoningEffort)=>void;disabled?:boolean}){
  return <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={e=>onChange(e.target.value as ReasoningEffort)}><option value="default">模型默认</option><option value="none">不思考</option><option value="minimal">极低 (minimal)</option><option value="low">低 (low)</option><option value="medium">中 (medium)</option><option value="high">高 (high)</option><option value="xhigh">极高 (xhigh)</option><option value="max">最大 (max)</option><option value="ultra">极致 (ultra)</option></select></label>;
}
