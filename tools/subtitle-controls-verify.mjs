/* Run the production preference, player and controller code with controlled
 * storage/media responses. Instrument private entrypoints only in this VM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = file => fs.readFileSync(new URL(file, root), 'utf8');
const stored = new Map(), timers = new Map(), nodes = new Map();
let timerId = 0, focus = null, pendingSubtitles = [];
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
  setInterval:()=>++timerId,clearInterval(){}, MediaSource:{isTypeSupported:()=>true},
  Diag:{plain:x=>x,record(){},log(){},note(){},priv:x=>x,incident(){}}, navigator:{userAgent:'test'},
  Auth:{isLoggedIn:()=>false,accessKey:()=>''},
  Nav:{onBack(){},onKey:f=>{context.__keyHandler=f;},current:()=>focus,focus:n=>{focus=n;},KEY:{RETURN:10009,UP:38,PLAY_PAUSE:10252,PLAY:415,PAUSE:19}},
  API:{subtitle:(url,ok,fail)=>pendingSubtitles.push({url,ok,fail})},
});
context.window=context; context.addEventListener=()=>{};
vm.runInContext(source('app/js/settings.js'),context);
let count=0;
async function check(label,run){await run();count++;console.log("✓ "+label);}
const {Settings}=context;
const human={lan:'en',lan_doc:'English',subtitle_url:'human'},ai={lan:'ai-en',ai_type:1,subtitle_url:'ai'},zh={lan:'zh-CN',subtitle_url:'zh'};
const regional={lan:'en-US',subtitle_url:'human-regional'};
await check('subtitle language memory, human priority, regional aliases and unavailable tracks',()=>{
 for(const [language,tracks,expected] of [
   ['en',[zh,ai,human],human],['en',[zh],zh],['en',[{lan:'en'}],null],
   ['ai-zh',[{lan:'ai-zh',ai_type:1,subtitle_url:'ai'},zh],zh],
   ['en-us',[ai,regional],regional]]){
  Settings.set('subtitleLanguage',language);
  const selected=Settings.chooseSubtitle(tracks);
  assert.equal(selected,expected);
  assert.equal(Settings.subtitleLanguage(),Settings.subtitleLanguageOf({lan:language}));
 }
 assert.equal(Settings.subtitleLanguage(),'en');assert.equal(Settings.subtitleLanguageOf({lan:'en-IE'}),'en');
 assert.notEqual(Settings.subtitleLanguageOf({lan:'zh-TW'}),Settings.subtitleLanguageOf(zh));
});
await check('subtitle language validates and survives a new settings instance',()=>{
 Settings.set('subtitleLanguage',{lan:'en'});assert.equal(Settings.subtitleLanguage(),'');
 Settings.set('subtitleLanguage','en');
 const fresh=vm.createContext({localStorage:storage});vm.runInContext(source('app/js/settings.js'),fresh);
 assert.equal(fresh.Settings.subtitleLanguage(),'en');
});
await check('automatic fallback keeps the first language and prefers humans only within it',()=>{
 const ja={lan:'ja',subtitle_url:'japanese'},jaAI={lan:'ai-ja',ai_type:1,subtitle_url:'ai-japanese'};
 const zhAI={lan:'ai-zh',ai_type:1,subtitle_url:'ai-chinese'};
 for(const preference of ['', 'fr']){
  Settings.set('subtitleLanguage',preference);
  for(const [tracks,expected] of [
   [[ai,ja],ai],[[ai,ja,human],human],[[jaAI,human,ja],ja],
   [[{lan:'de'},ai,ja],ai],[[ai,zhAI],zhAI],[[zhAI,zh],zh],[[null,{lan:'ja'}],null]]){
   assert.equal(Settings.chooseSubtitle(tracks),expected);
   assert.equal(Settings.subtitleLanguage(),preference);
  }
 }
});
context.Player={on(){},currentQuality:()=>0,qualityChoices:()=>[]};
let appSource=source('app/js/app.js');
appSource=appSource.replace('    window.onload = function () {',`    window.__controlsTest={
 session:function(s){playing=s;optionsOpen=true;toastEl=el('toast');return s;},
 subtitle:setSubtitleChoice,bind:bindPlaybackControls
};
    window.onload = function () {`);
vm.runInContext(appSource,context);
const app=context.__controlsTest;
const session=(extra={})=>app.session({detail:{bvid:'BVTEST'},cid:1,timed:true,subtitleTracks:[human,zh],...extra});
const pendingTracks=[];
context.API.playerV2=(bvid,cid,ok,fail)=>pendingTracks.push({bvid,cid,ok,fail});
await check('subtitle off, rapid selections and a new video reject stale responses',()=>{
 const s=session();app.subtitle(true,human,false);const off=pendingSubtitles.at(-1);
 app.subtitle(false,null,false);off.ok([{from:0,to:100,text:'stale'}]);
 assert.equal(node('subtitle-overlay').className,'hidden');assert.deepEqual(Array.from(s.subtitleCues),[]);
 app.subtitle(true,human,false);const first=pendingSubtitles.at(-1);app.subtitle(true,zh,false);const second=pendingSubtitles.at(-1);
 first.ok([{from:0,to:100,text:'wrong'}]);assert.equal(s.subtitleState,'loading');
 second.ok([{from:0,to:100,text:'right'}]);assert.equal(s.subtitleLoaded,zh);
 session();second.fail('late');assert.equal(s.subtitleState,'ready');
});
await check('subtitle empty, failed, retry and automatic states remain distinct',()=>{
 const s=session({subtitleTracks:[]});app.subtitle(true,null,true);assert.equal(s.subtitleState,'empty');
 s.subtitleTracks=[human];app.subtitle(true,human,false);pendingSubtitles.at(-1).fail('timeout');
 assert.equal(s.subtitleState,'failed');assert.match(node('panel-subtitles').textContent,/失败/);
 app.subtitle(true,human,false);pendingSubtitles.at(-1).ok([]);assert.equal(s.subtitleState,'empty');
 Settings.set('subtitleLanguage','en');app.subtitle(true,null,true);assert.equal(Settings.subtitleLanguage(),'');assert.equal(Settings.get('showSubtitles',false),true);
});
function retryTracks(extra={}){
 Settings.set('showSubtitles',true);
 const s=session({subtitleTracks:undefined,subtitleState:'failed',...extra});
 app.bind();node('panel-subtitles').onselect();return {s,request:pendingTracks.at(-1)};
}
await check('automatic selection during a list retry still downloads and renders captions',()=>{
 const {s,request}=retryTracks(),before=pendingSubtitles.length;
 app.subtitle(true,null,true);request.ok({subtitles:[human]});
 assert.equal(pendingSubtitles.length,before+1);assert.equal(s.subtitleState,'loading');
 pendingSubtitles.at(-1).ok([{from:0,to:100,text:'current captions'}]);
 assert.equal(s.subtitleState,'ready');assert.equal(node('subtitle-text').textContent,'current captions');
});
await check('off during a list retry keeps captions hidden and later enabling recovers',()=>{
 for(const failed of [false,true]){
  const {s,request}=retryTracks(),before=pendingSubtitles.length;
  app.subtitle(false,null,false);
  if(failed)request.fail('timeout');else request.ok({subtitles:[human]});
  assert.equal(pendingSubtitles.length,before);assert.equal(node('subtitle-overlay').className,'hidden');
  app.subtitle(true,null,true);
  if(failed){assert.notEqual(pendingTracks.at(-1),request);pendingTracks.at(-1).ok({subtitles:[human]});}
  assert.equal(pendingSubtitles.length,before+1);
  pendingSubtitles.at(-1).ok([{from:0,to:100,text:'re-enabled captions'}]);assert.equal(s.subtitleState,'ready');
 }
});
await check('failed list remains retryable after off and automatic selection',()=>{
 for(const tracks of [undefined,[]]){
  const {s,request}=retryTracks({subtitleTracks:tracks});request.fail('timeout');
  const lists=pendingTracks.length,bodies=pendingSubtitles.length;
  app.subtitle(false,null,false);
  assert.equal(pendingTracks.length,lists);assert.equal(node('subtitle-overlay').className,'hidden');
  app.subtitle(true,null,true);
  assert.equal(pendingTracks.length,lists+1);assert.equal(pendingSubtitles.length,bodies);
  pendingTracks.at(-1).ok({subtitles:[human]});assert.equal(pendingSubtitles.length,bodies+1);
  pendingSubtitles.at(-1).ok([{from:0,to:100,text:'recovered after failure then off'}]);
  assert.equal(s.subtitleState,'ready');assert.equal(node('subtitle-text').textContent,'recovered after failure then off');
 }
});
await check('off and automatic selection reuse a pending track list',()=>{
 const {s,request}=retryTracks(),lists=pendingTracks.length,bodies=pendingSubtitles.length;
 app.subtitle(false,null,false);app.subtitle(true,null,true);
 assert.equal(pendingTracks.length,lists);assert.equal(pendingSubtitles.length,bodies);
 request.ok({subtitles:[human]});assert.equal(pendingSubtitles.length,bodies+1);
 pendingSubtitles.at(-1).ok([{from:0,to:100,text:'reused pending list'}]);
 assert.equal(s.subtitleState,'ready');assert.equal(node('subtitle-text').textContent,'reused pending list');
});
await check('successful empty track list stays empty across off and automatic selection',()=>{
 const s=session({subtitleTracks:[],subtitleState:'empty'}),lists=pendingTracks.length,bodies=pendingSubtitles.length;
 app.subtitle(false,null,false);app.subtitle(true,null,true);
 assert.equal(pendingTracks.length,lists);assert.equal(pendingSubtitles.length,bodies);
 assert.equal(s.subtitleState,'empty');assert.equal(node('subtitle-overlay').className,'hidden');
 assert.match(node('panel-subtitles').textContent,/无可用字幕/);
});
await check('failed subtitle body retries cached tracks after off and automatic selection',()=>{
 const s=session({subtitleTracks:[human]});app.subtitle(true,human,false);pendingSubtitles.at(-1).fail('timeout');
 const lists=pendingTracks.length,bodies=pendingSubtitles.length;
 app.subtitle(false,null,false);app.subtitle(true,null,true);
 assert.equal(pendingTracks.length,lists);assert.equal(pendingSubtitles.length,bodies+1);
 assert.equal(pendingSubtitles.at(-1).url,human.subtitle_url);
 pendingSubtitles.at(-1).ok([{from:0,to:100,text:'retried cached track'}]);
 assert.equal(s.subtitleState,'ready');assert.equal(node('subtitle-text').textContent,'retried cached track');
});
await check('new video rejects both late list success and late list failure',()=>{
 for(const failed of [false,true]){
  const {request}=retryTracks(),before=pendingSubtitles.length;
  const current=session({cid:2,subtitleTracks:[zh],subtitleState:'empty'});
  if(failed)request.fail('late');else request.ok({subtitles:[human]});
  assert.equal(current.subtitleTracks[0],zh);assert.equal(current.subtitleState,'empty');
  assert.equal(pendingSubtitles.length,before);
 }
});
await check('retrying tracks without URLs also survives a newer automatic choice',()=>{
 session({subtitleTracks:[{lan:'en'}]});app.subtitle(true,null,true);
 const timer=Array.from(timers.values()).filter(t=>t.ms===2000).at(-1);assert.ok(timer);timer.f();
 const request=pendingTracks.at(-1),before=pendingSubtitles.length;
 app.subtitle(true,null,true);request.ok({subtitles:[human]});
 assert.equal(pendingSubtitles.length,before+1);
 pendingSubtitles.at(-1).ok([{from:0,to:100,text:'downloaded after list retry'}]);
 assert.equal(node('subtitle-text').textContent,'downloaded after list retry');
});
console.log(`${count}/${count} subtitle scenarios passed (controlled media, not device acceptance).`);
