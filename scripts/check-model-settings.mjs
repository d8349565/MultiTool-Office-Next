import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// 纯配置状态回归检查，不连接模型、不读取应用配置或业务文件。
const source=readFileSync(new URL('../src/settingsDraft.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {settingsEqual,rebaseSettings}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
assert.ok(settingsEqual({rules:[],holidays:{}},{holidays:{},rules:[]}));
assert.ok(!settingsEqual({rules:[1,2]},{rules:[2,1]}));
const before={revision:1,theme:'light',modelId:'old'};
const saved={...before,revision:2,modelId:'new',tavilyEnabled:false,modelTopP:null};
assert.deepEqual(rebaseSettings({...before,modelId:'new'},before,saved,['modelId']),saved);
assert.deepEqual(rebaseSettings({...before,theme:'dark',modelId:'new'},before,saved,['modelId']),{...saved,theme:'dark'});
assert.deepEqual(rebaseSettings(before,before,saved),saved);
console.log('模型设置状态检查通过');
