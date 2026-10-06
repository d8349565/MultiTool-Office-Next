import { listen } from '@tauri-apps/api/event';
import { api,desktop } from './api';
import type { AIResult } from './types';
import type { PiStart } from './officeAgent';

type Worker={alive:boolean;abort?:()=>void};
const workers=new Map<string,Worker>();
let listener:Promise<unknown>|undefined;
function launch(start:PiStart){
  if(workers.has(start.id))return;
  const worker:Worker={alive:true};workers.set(start.id,worker);
  void (async()=>{
    try{
      const {createOfficeAgent}=await import('./officeAgent');if(!worker.alive)return;
      const agent=createOfficeAgent(start,action=>api('pi_step',{id:start.id,action}));worker.abort=()=>agent.abort();
      await agent.prompt('执行当前已确认的任务');
      if(worker.alive&&agent.state.errorMessage)await api('pi_step',{id:start.id,action:{type:'fail',message:agent.state.errorMessage}}).catch(()=>{});
    }catch(error){if(worker.alive)await api('pi_step',{id:start.id,action:{type:'fail',message:String(error)}}).catch(()=>{});}
    finally{if(workers.get(start.id)===worker){worker.alive=false;workers.delete(start.id);}}
  })();
}
async function ensureListener(){
  if(!desktop)return;
  listener??=listen<PiStart>('pi-start',event=>launch(event.payload));
  try{await listener;}catch(error){listener=undefined;throw error;}
}
function dispose(id:string){const worker=workers.get(id);if(worker){worker.alive=false;worker.abort?.();workers.delete(id);}}
export async function runAssistantTask(args:Record<string,unknown>):Promise<AIResult>{
  await ensureListener();const id=String(args.id);
  try{return await api<AIResult>('ai_task',args);}finally{dispose(id);}
}
export async function resumeAssistantTask(result:AIResult){
  await ensureListener();
  const snapshot=(result as AIResult&{piRuntime?:PiStart}).piRuntime;
  if(result.status==='running'&&snapshot&&snapshot.id===result.id)launch(snapshot);
  else if(result.id)dispose(result.id);
}
// 页面刷新后，即使助手尚未展开，也恢复原生仍在运行的任务。
export async function initializeAssistantRuntime(){
  if(!desktop)return;await ensureListener();
  let ids:string[]=[];
  try{const saved=JSON.parse(localStorage.getItem('office-assistant-conversations-v1')||'null');ids=[...new Set<string>((saved?.sessions||[]).map((session:{task?:string;recoverTask?:string})=>session.task||session.recoverTask).filter((id:unknown)=>typeof id==='string'&&!!id))].slice(0,4);}catch{return;}
  await Promise.all(ids.map(async id=>{try{await resumeAssistantTask(await api<AIResult>('task_status',{id}));}catch{/* 已结束或旧版本任务由会话恢复界面处理。 */}}));
}
