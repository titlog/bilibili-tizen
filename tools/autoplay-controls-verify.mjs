/* Run the production preference, player and controller code with controlled
 * storage/media responses. Instrument private entrypoints only in this VM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = file => fs.readFileSync(new URL(file, root), 'utf8');
const stored = new Map(), timers = new Map(), nodes = new Map();
let intervals=0;
let timerId = 0, focus = null;
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {id, textContent:'', innerHTML:'', className:'', style:{},
    contains: () => false, querySelectorAll: () => [], querySelector: () => null,
    addEventListener(){}, removeAttribute(){}, pause(){}, load(){}, play(){return Promise.resolve();},
    getBoundingClientRect(){return {left:0,top:0,bottom:60,width:200,height:60};}});
  return nodes.get(id);
}
const storage = {getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)};
const context = vm.createContext({console,Promise,Blob,URL,ArrayBuffer,Uint8Array,
  localStorage:storage, REPORT_TO:'',SELFTEST:false,
  document:{getElementById:node,querySelectorAll:()=>[],querySelector:()=>null,body:node('body'),addEventListener(){},createElement:()=>node('new')},
  setTimeout:(f,ms)=>{const id=++timerId;timers.set(id,{f,ms});return id;}, clearTimeout:id=>timers.delete(id),
  setInterval:()=>{intervals++;return ++timerId;},clearInterval(){}, MediaSource:{isTypeSupported:()=>true},
  Diag:{plain:x=>x,record(){},log(){},note(){},priv:x=>x,incident(){}}, navigator:{userAgent:'test'},
  Auth:{isLoggedIn:()=>false,accessKey:()=>''},
  Nav:{onBack(){},onKey:f=>{context.__keyHandler=f;},current:()=>focus,focus:n=>{focus=n;},KEY:{RETURN:10009,UP:38,PLAY_PAUSE:10252,PLAY:415,PAUSE:19}},
  API:{subtitle(){}},
});
context.window=context; context.addEventListener=()=>{};
vm.runInContext(source('app/js/settings.js'),context);
const {Settings}=context;
context.Player={on(){},stop(){}};
context.EpisodeNav={adjacent:()=>null};
context.API.related=(b,ok)=>ok([{bvid:'NEXT'}]);
context.API.view=(b,ok)=>ok({bvid:b,cid:2,title:'next'});
let appSource=source('app/js/app.js');
appSource=appSource.replace('    window.onload = function () {',`    window.__autoTest={
 panel:bindAutoplayControl,enabled:autoNextEnabled,
 session:function(){playing={detail:{bvid:'BVTEST',related:[{bvid:'NEXT'}]},cid:1};optionsOpen=false;},
 end:beginAutoNext
};
nextupGrid={reset:function(){}};prefetchCard=function(){};
    window.onload = function () {`);
vm.runInContext(appSource,context);
const app=context.__autoTest;
assert.equal(app.enabled(),true);app.panel();node('panel-autoplay').onselect();
assert.equal(app.enabled(),false);assert.equal(node('panel-autoplay').textContent,'自动连播 关');
const fresh=vm.createContext({localStorage:storage});vm.runInContext(source('app/js/settings.js'),fresh);
assert.equal(fresh.Settings.get('autoplayNext',true),false);
Settings.set('autoplayNext',true);app.panel();assert.equal(node('panel-autoplay').textContent,'自动连播 开');
for(const enabled of [false,true]){
 Settings.set('autoplayNext',enabled);app.session();const before=intervals;app.end();
 assert.equal(node('nextup').className,'scroll');
 assert.equal(intervals-before,enabled?1:0);
 if(!enabled)assert.match(node('nextup-hint').textContent,/自动播放已关闭/);
}
const deviceSource=source('app/js/selftest.js').replace('    function run() {',
 '    window.__autoplayDeviceSteps = controlSteps;\n    function run() {');
vm.runInContext(deviceSource,context);
const steps=context.__autoplayDeviceSteps;
let presses=0;
context.API.view=()=>{};
context.document.createEvent=()=>({initEvent(kind){this.kind=kind;}});
context.document.dispatchEvent=e=>{
 if(e.kind==='keyup'&&e.keyCode===13){presses++;node('panel-autoplay').onselect();}
};
for(const initial of [false,true]){
 Settings.set('autoplayNext',initial);steps[0][2]();assert.equal(Settings.get('autoplayNext'),true);
 app.panel();focus=node('panel-autoplay');const before=presses;
 assert.equal(steps[3][2](),null);assert.equal(presses,before+1);assert.equal(Settings.get('autoplayNext'),false);
 steps.at(-1)[2]();assert.equal(Settings.get('autoplayNext'),initial);
}
console.log('Autoplay persistence, end-of-video chooser and device toggle from both starting states passed (controlled DOM).');
