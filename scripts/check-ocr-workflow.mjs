import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/ocrTypes.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {defaultWorkflow,oneClickWorkflow}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
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
