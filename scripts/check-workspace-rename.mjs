import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const { outputText }=ts.transpileModule(readFileSync(new URL('../src/domain.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const { renamedPath }=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
assert.equal(renamedPath('D:/工作/原名','D:/工作/原名','D:/工作/新名'),'D:/工作/新名');
assert.equal(renamedPath('D:\\Work\\Old\\child\\file.txt','d:/work/old','D:/Work/New'),'D:/Work/New/child/file.txt');
assert.equal(renamedPath('\\\\?\\D:\\Work\\Old\\child.txt','D:/Work/Old','D:/Work/New'),'D:/Work/New/child.txt');
assert.equal(renamedPath('D:/Work/Old-other/file.txt','D:/Work/Old','D:/Work/New'),'D:/Work/Old-other/file.txt');
assert.equal(renamedPath('E:/Work/Old/file.txt','D:/Work/Old','D:/Work/New'),'E:/Work/Old/file.txt');
assert.equal(renamedPath('D:/Work/New/file.txt','D:/Work/New','D:/Work/Old'),'D:/Work/Old/file.txt');
console.log('Workspace rename: navigation and descendant path checks passed.');
