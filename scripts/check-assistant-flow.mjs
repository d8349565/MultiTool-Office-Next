import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,realpathSync } from 'node:fs';
import { dirname,join,relative,resolve,sep } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import ts from 'typescript';

// 真实 PI 调度器 + 虚构的原生回包；不启动模型服务、不读取业务文件。
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=join(root,'test-results');mkdirSync(base,{recursive:true});
const scratch=mkdtempSync(join(base,'assistant-audit-'));
const compiled=ts.transpileModule(readFileSync(join(root,'src/officeAgent.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
writeFileSync(join(scratch,'officeAgent.mjs'),compiled);
const {createOfficeAgent}=await import(pathToFileURL(join(scratch,'officeAgent.mjs')).href);
const tool={function:{name:'document_create',description:'Synthetic document fixture',parameters:{type:'object',properties:{filename:{type:'string'}},required:['filename'],additionalProperties:false}}};
const reply=(round,calls=[],continued=false)=>({round,continue:continued,response:{choices:[{message:{content:calls.length?null:'已完成虚构任务',...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop'}]}});
const call=(id,name='document_create',args={filename:'audit.txt'})=>({id,function:{name,arguments:JSON.stringify(args)}});
let checks=0;
async function check(name,test){await test();checks++;console.log('PASS '+name);}
try{
  await check('普通回复不调用工具',async()=>{
    const actions=[];const agent=createOfficeAgent({id:'chat',round:0,modelId:'audit-model',tools:[tool]},async action=>{actions.push(action);return reply(action.round);});
    await agent.prompt('虚构问答');assert.equal(agent.state.errorMessage,undefined);assert.deepEqual(actions,[{type:'model',round:0}]);
  });
  await check('多文件工具按原生顺序执行',async()=>{
    const actions=[];const agent=createOfficeAgent({id:'tools',round:0,modelId:'audit-model',tools:[tool]},async action=>{
      actions.push(action);return action.type==='model'?reply(action.round,action.round===0?[call('first'),call('second')]:[]):{content:'{"status":"created"}',isError:false};
    });
    await agent.prompt('虚构多文件任务');assert.equal(agent.state.errorMessage,undefined);
    assert.deepEqual(actions.map(a=>`${a.type}:${a.round}:${a.callId||''}`),['model:0:','tool:0:first','tool:0:second','model:1:']);
  });
  for(const [name,toolCall] of [['参数校验失败',call('invalid','document_create',{})],['未知工具',call('unknown','missing_tool',{})]]){
    await check(name+'等待原生拒绝回包再请求下一轮',async()=>{
      let rejecting=false;const actions=[];
      const agent=createOfficeAgent({id:name,round:0,modelId:'audit-model',tools:[tool]},async action=>{
        actions.push(action);
        if(action.type==='model'){assert.equal(rejecting,false,'原生工具拒绝尚未处理，PI 已提前请求下一轮');return reply(action.round,action.round===0?[toolCall]:[]);}
        assert.equal(action.rejected,true);rejecting=true;await new Promise(resolve=>setTimeout(resolve,30));rejecting=false;return {content:'{"error":"synthetic rejection"}',isError:true};
      });
      await agent.prompt('虚构错误参数');assert.equal(agent.state.errorMessage,undefined);
      assert.equal(actions.filter(a=>a.type==='tool'&&a.rejected).length,1);
    });
  }
  await check('原生要求继续汇报时继续下一轮',async()=>{
    const rounds=[];const agent=createOfficeAgent({id:'continue',round:0,modelId:'audit-model',tools:[]},async action=>{rounds.push(action.round);return reply(action.round,[],action.round===0);});
    await agent.prompt('虚构续写');assert.equal(agent.state.errorMessage,undefined);assert.deepEqual(rounds,[0,1]);
  });
  await check('从原生快照恢复后使用正确轮次',async()=>{
    const actions=[];const agent=createOfficeAgent({id:'resume',round:4,modelId:'audit-model',tools:[tool],replay:reply(3,[call('pending')])},async action=>{actions.push(action);return action.type==='model'?reply(action.round):{content:'{}',isError:false};});
    await agent.prompt('恢复虚构任务');assert.equal(agent.state.errorMessage,undefined);assert.deepEqual(actions.map(a=>`${a.type}:${a.round}`),['tool:3','model:4']);
  });
  console.log(`助理调度检查通过：${checks} 项`);
}finally{
  const owned=relative(realpathSync(base),realpathSync(scratch));
  assert.ok(owned&&!owned.startsWith('..'+sep)&&!owned.startsWith(sep)&&!owned.includes(sep));
  rmSync(scratch,{recursive:true,force:true});
}
