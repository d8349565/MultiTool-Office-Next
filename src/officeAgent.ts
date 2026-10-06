import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Model, type TSchema } from '@earendil-works/pi-ai';

export interface PiReply {
  response: { choices: { message: { content?: string | null; reasoning_content?: string; tool_calls?: { id:string; function:{ name:string; arguments:string } }[] }; finish_reason:string }[]; usage?: { prompt_tokens?:number; completion_tokens?:number; total_tokens?:number } };
  round:number; continue?:boolean;
}
export interface PiStart { id:string; round:number; modelId:string; tools:{ function:{ name:string; description:string; parameters:Record<string,unknown> } }[]; replay?:PiReply|null }
export type PiAction = {type:'model';round:number}|{type:'tool';round:number;callId:string;rejected?:boolean}|{type:'fail';message:string};
export type PiStep = (action:PiAction)=>Promise<unknown>;
interface ToolReply { content:string; isError:boolean; terminate?:boolean }
// 同一注册表重复使用模式，避免每次任务重新生成校验器。
const schemas = new Map<string,TSchema>();
function parameters(spec:Record<string,unknown>):TSchema {
  const key=JSON.stringify(spec);let schema=schemas.get(key);
  if(!schema){schema=Type.Unsafe(spec);schemas.set(key,schema);}return schema;
}
export function createOfficeAgent(start:PiStart,step:PiStep) {
  const model:Model<'openai-completions'>={id:start.modelId,name:start.modelId,provider:'office',api:'openai-completions',baseUrl:'',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:0,maxTokens:0};
  let nextRound=start.round, currentRound=start.replay?.round??start.round, replay=start.replay, continueRequested=false;
  const delivered=new Set<string>();
  async function execute(callId:string,rejected=false):Promise<ToolReply>{
    delivered.add(`${currentRound}:${callId}`);
    return await step({type:'tool',round:currentRound,callId,rejected}) as ToolReply;
  }
  const tools:AgentTool[]=start.tools.map(spec=>({
    name:spec.function.name,label:spec.function.name,description:spec.function.description,parameters:parameters(spec.function.parameters),
    execute:async(callId,_args,signal)=>{
      signal?.throwIfAborted();const result=await execute(callId);
      if(result.isError&&!result.terminate)throw new Error(result.content);
      return {content:[{type:'text',text:result.content}],details:undefined,terminate:result.terminate};
    },
  }));
  const streamFn:StreamFn=(_model,_context,options)=>{
    const stream=createAssistantMessageEventStream();
    const message:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
    void (async()=>{
      try{
        options?.signal?.throwIfAborted();
        const result=replay??await step({type:'model',round:nextRound++}) as PiReply;replay=null;
        options?.signal?.throwIfAborted();
        currentRound=result.round;continueRequested=!!result.continue;
        const choice=result.response.choices[0];if(!choice)throw new Error('模型没有返回有效回复');
        if(!['stop','tool_calls'].includes(choice.finish_reason))throw new Error('模型回复未完成，已保留原生任务记录');
        const content=choice.message.content;if(content)message.content.push({type:'text',text:content});
        for(const call of choice.message.tool_calls??[])message.content.push({type:'toolCall',id:call.id,name:call.function.name,arguments:JSON.parse(call.function.arguments)});
        message.stopReason=message.content.some(block=>block.type==='toolCall')?'toolUse':'stop';
        const usage=result.response.usage;
        if(usage){message.usage.input=usage.prompt_tokens??0;message.usage.output=usage.completion_tokens??0;message.usage.totalTokens=usage.total_tokens??message.usage.input+message.usage.output;}
        stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});
      }catch(error){message.stopReason='error';message.errorMessage=String(error);stream.push({type:'error',reason:'error',error:message});}
      finally{stream.end(message);}
    })();return stream;
  };
  const agent=new Agent({initialState:{model,tools,systemPrompt:'执行原生任务授权的模型与工具步骤。原生网关是权限与任务状态的唯一来源。'},streamFn,toolExecution:'sequential',finishTurn:()=>continueRequested?{action:'continue'}:undefined});
  agent.subscribe(async event=>{
    // 未知工具或校验拒绝仍需通知原生任务，使其能安全收尾。
    if(event.type==='tool_execution_end'&&!delivered.has(`${currentRound}:${event.toolCallId}`))await execute(event.toolCallId,true);
  });
  return agent;
}
