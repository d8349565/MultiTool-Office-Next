import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

// Render the real directory component with React; exercise its event callbacks without opening system folders.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=join(root,'test-results');mkdirSync(base,{recursive:true});
const scratch=mkdtempSync(join(base,'directory-actions-'));
try{
  const bundle=await build({entryPoints:[join(root,'src/components.tsx')],bundle:true,platform:'node',format:'esm',packages:'external',write:false,jsx:'automatic'});
  const modulePath=join(scratch,'components.mjs');writeFileSync(modulePath,bundle.outputFiles[0].text);
  const {DirectoryPanel}=await import(pathToFileURL(modulePath).href);
  const entry={path:'D:/directory-actions/目录',parent:'D:/directory-actions',name:'目录',isDir:true,extension:'',size:0,modified:0};
  const opened=[],selected=[],renamed=[];
  let tree;
  function Probe(){
    tree=DirectoryPanel({title:'一级目录',level:1,parent:entry.parent,items:[entry],busy:false,onOpen:e=>opened.push(e),onSelect:e=>selected.push(e),onRename:e=>renamed.push(e),onCopy:()=>{}});
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  function find(node,predicate){
    if(!React.isValidElement(node))return undefined;
    if(predicate(node))return node;
    for(const child of React.Children.toArray(node.props.children)){const found=find(child,predicate);if(found)return found;}
  }
  const row=find(tree,node=>node.props.role==='option');assert.ok(row,'Directory row must be present');
  let prevented=false;
  row.props.onContextMenu?.({preventDefault(){prevented=true;}});
  assert.deepEqual(opened,[entry],'Right-click must immediately open the clicked directory');
  assert.equal(prevented,true,'Directory right-click must suppress the browser menu');
  row.props.onClick();assert.deepEqual(selected,[entry],'Single-click must still browse the directory');
  row.props.onKeyDown({key:'F2',preventDefault(){}});assert.deepEqual(renamed,[entry],'F2 must still rename the directory');
  prevented=false;
  tree.props.onContextMenu?.({preventDefault(){prevented=true;}});
  assert.equal(prevented,true,'Panel background must suppress the browser menu');
  assert.deepEqual(opened,[entry],'Panel background must not open a different directory');
  console.log('Directory actions passed: right-click opens, single-click browses, F2 renames, blank area suppresses browser menu.');
}finally{
  const owned=relative(realpathSync(base),realpathSync(scratch));
  assert.ok(owned&&!owned.startsWith('..'+sep)&&!owned.startsWith(sep)&&!owned.includes(sep));
  rmSync(scratch,{recursive:true,force:true});
}
