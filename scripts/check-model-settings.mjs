import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// 纯配置状态回归检查，不连接模型、不读取应用配置或业务文件。
const source=readFileSync(new URL('../src/settingsDraft.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {settingsEqual,rebaseSettings,settingsFieldEqual,searchSettingsChanged,searchSettingsKeys}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
assert.ok(settingsEqual({rules:[],holidays:{}},{holidays:{},rules:[]}));
assert.ok(!settingsEqual({rules:[1,2]},{rules:[2,1]}));
const before={revision:1,theme:'light',modelId:'old'};
const saved={...before,revision:2,modelId:'new',tavilyEnabled:false,modelTopP:null};
assert.deepEqual(rebaseSettings({...before,modelId:'new'},before,saved,['modelId']),saved);
assert.deepEqual(rebaseSettings({...before,theme:'dark',modelId:'new'},before,saved,['modelId']),{...saved,theme:'dark'});
assert.deepEqual(rebaseSettings(before,before,saved),saved);
// 搜索表单与页面使用同一份草稿：保存后清除标记，其他模块的草稿仍保留。
const original={revision:3,theme:'light',searchEnabled:true,searchProvider:'tavily',deepseekSearchProfileId:null,deepseekFetchEnabled:false};
const edited={...original,searchProvider:'deepseek',deepseekSearchProfileId:'legacy',deepseekFetchEnabled:true};
const committed={...edited,revision:4};
assert.ok(searchSettingsChanged(edited,original));
assert.ok(!searchSettingsChanged(rebaseSettings(edited,original,committed,searchSettingsKeys),committed));
assert.equal(rebaseSettings({...edited,theme:'dark'},original,committed,searchSettingsKeys).theme,'dark');
assert.equal(rebaseSettings(edited,original,{...original,revision:4,theme:'dark'}).searchProvider,'deepseek');
assert.ok(!searchSettingsChanged({}, {searchEnabled:false,searchProvider:'tavily',deepseekSearchProfileId:null,deepseekFetchEnabled:false}));
for(const key of searchSettingsKeys)assert.ok(settingsFieldEqual(committed,{...committed},key));
assert.ok(searchSettingsChanged({...original,deepseekSearchProfileId:'legacy'},original));
assert.ok(searchSettingsChanged({...original,deepseekFetchEnabled:true},original));
console.log('模型与搜索设置状态检查通过');
