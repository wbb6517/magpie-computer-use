import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { nativeCall, NATIVE_TOOLS } from '../src/native-tools.mjs';

const identity={sessionId:'test-session',turnId:'test-turn'};
function originalApiFixture() {
  const events=[];
  const target={};
  for (const method of ['getScreenshot','getAXState','click','performSecondaryAction','setValue','selectText','scroll','drag','pressKey','typeText']) {
    target[method]=async (...args)=>{events.push({method,args});};
  }
  const context=vm.createContext({cua:{listApps:async()=>{events.push({method:'listApps'});},getApp:async app=>{events.push({method:'getApp',app});return target;}}});
  return {events,run:async(name,args,who=identity)=>{
    const script=nativeCall(name,args,who).code;
    // 原始 REPL 每个 cell 重置该 cell 声明的 var；普通 vm 不会，显式模拟以覆盖实测回归。
    for(const match of script.matchAll(/\bvar\s+(__magpie[A-Za-z0-9_]*)/g)) context[match[1]]=undefined;
    return vm.runInContext(script.replace('await (async () => {', '(async () => {').replace(/^await cua.listApps\(\);$/, 'cua.listApps();'),context);
  }};
}

test('ten native operations map to the original API and return fresh state after input',async()=>{
 const f=originalApiFixture();
 assert.deepEqual(NATIVE_TOOLS.map(t=>t.name),['list_apps','get_app_state','click','perform_secondary_action','set_value','select_text','scroll','drag','press_key','type_text']);
 await f.run('list_apps',{});
 await assert.rejects(f.run('click',{app:'Finder',element_index:'2'}),/get_app_state/);
 await f.run('get_app_state',{app:'Finder'});
 assert.deepEqual(f.events.slice(-2).map(x=>x.method),['getApp','getScreenshot']);
 for(const [name,args,method] of [
 ['click',{element_index:'2',click_count:2,mouse_button:'right'},'click'],
 ['click',{x:12,y:24},'click'],
 ['perform_secondary_action',{element_index:'3',action:'Expand'},'performSecondaryAction'],
 ['set_value',{element_index:'4',value:'edited'},'setValue'],
 ['select_text',{element_index:'5',text:'same',prefix:'before',suffix:'after',selection:'cursor_after'},'selectText'],
 ['scroll',{element_index:'6',direction:'down',pages:0.5},'scroll'],
 ['drag',{from_x:1,from_y:2,to_x:3,to_y:4},'drag'],
 ['press_key',{key:'super+c'},'pressKey'],
 ['type_text',{text:'literal'},'typeText'],
 ]) {await f.run(name,{app:'Finder',...args});assert.deepEqual(f.events.slice(-2).map(x=>x.method),[method,'getAXState']);}
 const select=f.events.find(x=>x.method==='selectText');
 assert.equal(select.args[0],5);assert.equal(select.args[2].selectionType,'cursor_after');
 const scroll=f.events.find(x=>x.method==='scroll');assert.equal(scroll.args[2],0.5);
 await assert.rejects(f.run('type_text',{app:'Finder',text:'x'},{...identity,turnId:'different'}),/get_app_state/);
});

test('user strings are literal data and cannot inject JavaScript into the adapter',async()=>{
 const f=originalApiFixture(); const hostile='\"; throw new Error(\"injected\"); // ${process.exit()}\n汉字';
 await f.run('get_app_state',{app:hostile});
 await f.run('type_text',{app:hostile,text:hostile});
 const call=f.events.find(x=>x.method==='typeText');assert.equal(call.args[0],hostile);
});

test('invalid native arguments are refused before reaching the original runtime',()=>{
 for(const [name,args] of [
 ['click',{app:'Finder'}],['click',{app:'Finder',element_index:'1',x:1,y:1}],
 ['click',{app:'Finder',x:Infinity,y:1}],['click',{app:'Finder',element_index:'1; run()'}],
 ['set_value',{app:'Finder',element_index:'9007199254740993',value:'x'}],
 ['scroll',{app:'Finder',element_index:'1',direction:'down',pages:0}],
 ['type_text',{app:'Finder',text:'x',code:'injected'}],['get_app_state',{app:' '}],
 ]) assert.throws(()=>nativeCall(name,args,identity));
});
