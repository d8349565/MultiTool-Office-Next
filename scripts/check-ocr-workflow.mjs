import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/ocrTypes.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {defaultWorkflow,oneClickWorkflow,completedOcrFileIds,completedOcrTask}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
assert.equal(defaultWorkflow.rename,'apply');
assert.equal(defaultWorkflow.renameConfirmed,false);
// Old saved review/preview settings must not leave a one-click task half-finished.
for(const rename of ['review','preview','apply']){
  for(const exportFormat of ['none','txt','csv','json']){
    const saved={exportFormat,exportDirectory:'D:/synthetic-output',rename,renameConfirmed:false};
    const options=oneClickWorkflow(saved);
    assert.equal(options.rename,'apply');
    assert.equal(options.renameConfirmed,true);
    assert.equal(options.exportFormat,exportFormat);
    assert.equal(options.exportDirectory,saved.exportDirectory);
    assert.equal(saved.rename,rename);
    assert.equal(saved.renameConfirmed,false);
  }
}
console.log('OCR one-click workflow: legacy settings, explicit task authorization, and export preservation passed.');

// Check the production completion rules without starting OCR or touching document files.
const result=(id,status='ready',extra={})=>({id,status,path:`D:/status-check/${id}.pdf`,error:'',warning:'',reviewed:false,...extra});
const task={id:'status-check',status:'completed',files:[
  result('success'),result('review','review'),result('warning','ready',{warning:'needs review'}),
  result('checked','review',{reviewed:true,warning:'confirmed'}),
  ...['failed','cancelled','interrupted','relocated','queued','running'].map(status=>result(status,status,{reviewed:true})),
  result('error','ready',{reviewed:true,error:'not complete'}),
]};
assert.deepEqual(completedOcrFileIds(task,[]),['success','checked']);
assert.equal(completedOcrTask(task,[]),false);
for(const status of ['queued','running'])assert.deepEqual(completedOcrFileIds({...task,status},[]),[]);
const success={...task,files:[result('success')]};
assert.equal(completedOcrTask(success,[]),true);
assert.equal(completedOcrTask({...success,status:'failed'},[]),false);
const workflow={enabled:true,status:'review',options:{...defaultWorkflow,exportFormat:'csv'},exportPath:'',error:''};
const batch={taskId:task.id,items:[{fileId:'success',target:success.files[0].path,status:'done',error:''}]};
assert.deepEqual(completedOcrFileIds({...success,workflow},[batch]),[]);
workflow.exportPath='D:/status-check/output.csv';
assert.deepEqual(completedOcrFileIds({...success,workflow},[]),[]);
assert.deepEqual(completedOcrFileIds({...success,workflow},[batch]),['success']);
assert.equal(completedOcrTask({...success,workflow},[batch]),false);
assert.equal(completedOcrTask({...success,workflow:{...workflow,status:'completed'}},[batch]),true);
assert.deepEqual(completedOcrFileIds({...success,workflow},[{...batch,items:[{...batch.items[0],status:'failed'}]}]),[]);
assert.deepEqual(completedOcrFileIds({...success,workflow},[{...batch,taskId:'other-task'}]),[]);
assert.deepEqual(completedOcrFileIds({...success,workflow},[{...batch,items:[{...batch.items[0],target:'D:/status-check/other.pdf'}]}]),[]);
console.log('OCR completion rules: review, failure, interruption, export, and rename protection passed.');
