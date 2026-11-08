/* Run the production preference, player and controller code with controlled
 * storage/media responses. Instrument private entrypoints only in this VM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const root = new URL('../', import.meta.url);
const source = file => fs.readFileSync(new URL(file, root), 'utf8');
const stored = new Map(), timers = new Map(), nodes = new Map();
const mediaListeners = new Map();
let timerId = 0, eventHandler, focus = null, calls = [], incidents = [];
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {id, textContent:'', innerHTML:'', className:'', style:{},
    contains: () => false, querySelectorAll: () => [], querySelector: () => null,
    addEventListener(kind,fn){if(id==='html5-video')mediaListeners.set(kind,fn);}, removeAttribute(){}, pause(){}, load(){}, play(){return Promise.resolve();},
    getBoundingClientRect(){return {left:0,top:0,bottom:60,width:200,height:60};}});
  return nodes.get(id);
}
const storage = {getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)};
const context = vm.createContext({console,Promise,Blob,URL,ArrayBuffer,Uint8Array,
  localStorage:storage, REPORT_TO:'',SELFTEST:false,
  document:{getElementById:node,querySelectorAll:()=>[],querySelector:()=>null,body:node('body'),addEventListener(){},createElement:()=>node('new')},
  setTimeout:(f,ms)=>{const id=++timerId;timers.set(id,{f,ms});return id;}, clearTimeout:id=>timers.delete(id),
  setInterval:()=>++timerId,clearInterval(){}, MediaSource:{isTypeSupported:()=>true},
  Diag:{plain:x=>x,record(){},log(){},note(){},priv:x=>x,incident:x=>incidents.push(x)}, navigator:{userAgent:'test'},
  Auth:{isLoggedIn:()=>false,accessKey:()=>''},
  Nav:{onBack(){},onKey:f=>{context.__keyHandler=f;},current:()=>focus,focus:n=>{focus=n;},KEY:{RETURN:10009,UP:38,PLAY_PAUSE:10252,PLAY:415,PAUSE:19}},
  API:{subtitle(){}},
});
context.window=context; context.addEventListener=()=>{};
vm.runInContext(source('app/js/settings.js'),context);
vm.runInContext(source('app/js/mpd.js'),context);
let count=0;
async function check(label,run){await run();count++;console.log('✓ '+label);}
const {Settings,Mpd}=context;
await check('quality defaults, validation, fallback, cap and persistence',()=>{
 assert.equal(Settings.qualityPreference(),0);
 Settings.set('preferredQn',112);
 assert.equal(Settings.resolveQuality([80,64,32]),80);assert.equal(Settings.resolveQuality([80],16),80);
 Settings.set('maxQn',32);assert.equal(Settings.resolveQuality([120,80,32,16]),32);
 assert.equal(Settings.qualityPreference(),112);Settings.set('maxQn',120);
 Settings.set('preferredQn','bad');
 assert.equal(Settings.qualityPreference(),0);
 Settings.set('preferredQn',64);
 const fresh=vm.createContext({localStorage:storage});vm.runInContext(source('app/js/settings.js'),fresh);
 assert.equal(fresh.Settings.qualityPreference(),64);
});
const rep=id=>({id,codecs:'hvc1.1.6.L120.90',width:1920,height:1080,bandwidth:id*10000,urls:['https://example.invalid/v'],segments:{init:'0-9',index:'10-19'}});
const dash={duration:120,video:[rep(80),rep(64),rep(32)],audio:[{...rep(30280),codecs:'mp4a.40.2'}]};
await check('available tiers exclude advertising, duplicates and missing indexes',()=>{
 assert.deepEqual(Array.from(Mpd.tiers({...dash,acceptQuality:[120],video:[...dash.video,rep(80),{...rep(120),segments:null}]},120)),[80,64,32]);
});
// Exercise real Player methods without decoding or network.
let playerSource=source('app/js/player.js');
playerSource=playerSource.replace('    return {\n        on:',`    window.__playerControlsTest = {
      set: function(p) { shakaPlayer=p; mode='mse'; loadPending=false; qualityRequest=Settings.qualityPreference(); },
      pending: function(on) { loadPending=on; }, bindMedia: bindMediaElement,
      settled: function() { return shakaOp; },
      finish: finishQualitySwitch
    };
    return {\n        on:`);
vm.runInContext(playerSource,context);
const realPlayer=context.Player, playerTest=context.__playerControlsTest;
let active={id:1,originalVideoId:'80',active:true,audioId:1},low={id:2,originalVideoId:'32',audioId:1};
let abr=true;
const engine={getVariantTracks:()=>[active,low],configure:c=>{if(c.abr)abr=c.abr.enabled;},selectVariantTrack:(t,clear,margin)=>{calls.push({t,clear,margin});}};
let events=[];
const hasEvent=kind=>events.some(e=>e.kind===kind);
realPlayer.on((kind,data)=>events.push({kind,data}));
await check('manual quality confirmation, rollback, auto, actual IDs and 2x buffer',()=>{
 Settings.set('preferredQn',0);playerTest.set(engine);let done=null;
 assert.equal(realPlayer.selectQuality(32,e=>done=e),true);
 assert.equal(abr,false);assert.equal(calls.at(-1).t,low);assert.equal(done,null);
 playerTest.finish('');assert.equal(done,'');
 for(const rate of [1,2]){
  engine.trickPlay=()=>{};engine.cancelTrickPlay=()=>{};realPlayer.setRate(rate);playerTest.set(engine);
  realPlayer.selectQuality(32,e=>done=e);
  assert.equal(calls.at(-1).margin,4*rate);assert.equal(calls.at(-1).t.audioId,active.audioId);
  playerTest.finish('network');assert.equal(done,'network');assert.equal(abr,true);
  assert.equal(calls.at(-1).t,active);assert.equal(calls.at(-1).margin,4*rate);
 }
 realPlayer.setRate(1);assert.equal(realPlayer.selectQuality(0,e=>done=e),true);
 assert.equal(done,'');assert.equal(abr,true);assert.equal(realPlayer.currentQuality(),80);
 assert.deepEqual(Array.from(realPlayer.qualityChoices()),[80,32]);
});
await check('loading hides stale quality and rejects old media events',()=>{
 playerTest.set({getVariantTracks:()=>[{originalVideoId:'120',active:true}]});
 assert.equal(realPlayer.currentQuality(),120);playerTest.pending(true);
 assert.equal(realPlayer.currentQuality(),0);assert.deepEqual(Array.from(realPlayer.qualityChoices(dash)),[80,64,32]);
 realPlayer.stop();playerTest.set(engine);playerTest.bindMedia();playerTest.pending(true);events=[];
 const video=node('html5-video');Object.assign(video,{currentTime:90,readyState:4,paused:false});
 for(const kind of ['timeupdate','playing','ended'])mediaListeners.get(kind)();
 assert.equal(realPlayer.hasPosition(),false);assert.equal(events.length,0);
 playerTest.pending(false);mediaListeners.get('timeupdate')();assert.equal(realPlayer.position(),90000);
 video.ended=false;mediaListeners.get('ended')();assert.equal(hasEvent('ended'),false);
 video.ended=true;mediaListeners.get('ended')();assert.equal(hasEvent('ended'),true);realPlayer.stop();
});
// Drive the serialized production loader. Manual completion requires video data.
const tick=()=>new Promise(setImmediate), sdkListeners=new Map(), video=node('html5-video');
let loaded,appliedRate=1,starts=0;
video.pause=()=>{video.paused=true;};video.play=()=>{starts++;video.paused=false;return Promise.resolve();};
Object.assign(engine,{unload:()=>Promise.resolve(),attach:()=>Promise.resolve(),
 load:()=>new Promise(resolve=>{loaded=()=>{video.paused=!video.autoplay;resolve();};}),
 addEventListener:(kind,fn)=>sdkListeners.set(kind,fn),cancelTrickPlay:()=>{appliedRate=1;},
 trickPlay:r=>{if(video.paused)video.play();appliedRate=r;}}); // Shaka 4.12.5 auto-resumes here.
function FakeShaka(){return engine;}FakeShaka.isBrowserSupported=()=>true;
context.shaka={Player:FakeShaka,polyfill:{installAll(){}}};playerTest.set(null);Settings.set('preferredQn',0);
async function beginDash(qn,{paused=true,complete=true}={}){
 active.active=true;low.active=false;events=[];realPlayer.playDash(dash,0,{quality:qn,paused});await tick();
 if(complete){loaded();await tick();}
}
await check('early autoplay is published after readiness',async()=>{
 await beginDash(0,{paused:false,complete:false});assert.equal(typeof loaded,'function');mediaListeners.get('playing')();
 assert.equal(hasEvent('playing'),false);loaded();await playerTest.settled();
 assert.equal(hasEvent('ready'),true);assert.equal(hasEvent('playing'),true);
 assert.ok(events.findIndex(e=>e.kind==='ready')<events.findIndex(e=>e.kind==='playing'));
 video.currentTime=1;mediaListeners.get('timeupdate')();assert.equal(realPlayer.position(),1000);
});
await check('quality rollback preserves the original audio error recovery',async()=>{
 for(const severity of [1,2]){
  await beginDash(0,{paused:false});await playerTest.settled();let retries=0,done=null;
  engine.retryStreaming=()=>{retries++;};realPlayer.selectQuality(32,why=>done=why);
  sdkListeners.get('error')({detail:{category:1,code:1002,severity,data:['https://example.invalid/audio']}});
  assert.equal(retries,1);
  // A recoverable error is Shaka retrying: the switch stays pending (its timer bounds it).
  if(severity===1){assert.equal(done,null);active.active=false;low.active=true;sdkListeners.get('segmentappended')({contentType:'video'});assert.equal(done,'');}
  else{assert.match(done,/1002/);assert.equal(calls.at(-1).t,active);}
 }
});
await check('a stop during an in-play switch still answers it',async()=>{
 await beginDash(0,{paused:false});await playerTest.settled();let done=null;
 realPlayer.selectQuality(32,why=>done=why);assert.equal(done,null);
 realPlayer.stop();assert.match(String(done),/画质切换未完成/);await playerTest.settled();
});
await check('saved manual startup survives recoverable network and media errors',async()=>{
 for(const qn of [32,80])for(const paused of [false,true])for(const category of [1,3]){
  Settings.set('preferredQn',qn);await beginDash(qn,{paused});let retries=0;
  engine.retryStreaming=()=>{retries++;};
  sdkListeners.get('error')({detail:{category,code:category===1?1002:3015,severity:1,data:[]}});
  await tick();assert.equal(retries,1);assert.equal(hasEvent('error'),false);assert.equal(hasEvent('ready'),false);
  sdkListeners.get('segmentappended')({contentType:'audio'});await tick();assert.equal(hasEvent('ready'),false);
  active.active=qn===80;low.active=qn===32;sdkListeners.get('segmentappended')({contentType:'video'});
  await playerTest.settled();assert.equal(events.filter(e=>e.kind==='ready').length,1);
  assert.equal(hasEvent('error'),false);assert.equal(realPlayer.currentQuality(),qn);
  assert.equal(realPlayer.userPaused(),paused);assert.equal(video.paused,paused);
  video.currentTime=42;mediaListeners.get('timeupdate')();assert.equal(realPlayer.position(),42000);
  assert.equal(Settings.qualityPreference(),qn);
 }
 Settings.set('preferredQn',0);
});
await check('critical startup errors go to recovery alone, and startup completes after it',async()=>{
 await beginDash(32);let retries=0;engine.retryStreaming=()=>{retries++;};
 sdkListeners.get('error')({detail:{category:1,code:1002,severity:2,data:[]}});
 await tick();assert.equal(retries,1);assert.equal(hasEvent('error'),false);assert.equal(hasEvent('ready'),false);
 low.active=true;active.active=false;sdkListeners.get('segmentappended')({contentType:'video'});
 await playerTest.settled();assert.equal(events.filter(e=>e.kind==='ready').length,1);
});
for(const qn of [32,80])await check(`manual DASH ${qn} waits for this load's video data`,async()=>{
 await beginDash(qn);assert.equal(hasEvent('ready'),false);
 sdkListeners.get('segmentappended')({contentType:'audio'});await tick();assert.equal(hasEvent('ready'),false);
 active.active=qn===80;low.active=qn===32;sdkListeners.get('segmentappended')({contentType:'video'});
 await playerTest.settled();assert.equal(hasEvent('ready'),true);assert.equal(realPlayer.userPaused(),true);
});
await check('new video cancels pending manual load and releases the queue',async()=>{
 await beginDash(32);assert.equal(hasEvent('ready'),false);const oldLoad=loaded;
 await beginDash(0,{paused:false,complete:false});assert.notEqual(loaded,oldLoad);assert.equal(hasEvent('ready'),false);
 loaded();await playerTest.settled();assert.equal(events.filter(e=>e.kind==='ready').length,1);
});
function fireTimer(ms){
 const entry=Array.from(timers).filter(([,t])=>t.ms===ms).at(-1);assert.ok(entry,`timer ${ms} exists`);
 timers.delete(entry[0]);entry[1].f();
}
await check('slow target video at startup plays what is buffered, without an error or saving a preference',async()=>{
 await beginDash(32);fireTimer(20000);await playerTest.settled();
 assert.equal(hasEvent('ready'),true);assert.equal(hasEvent('error'),false);assert.equal(Settings.qualityPreference(),0);
});
await check('paused speed changes and rebuild wait for resume',async()=>{
 await beginDash(0);await playerTest.settled();const before=starts;
 assert.equal(realPlayer.setRate(2),true);assert.equal(video.paused,true);
 await beginDash(0);await playerTest.settled();assert.equal(video.paused,true);assert.equal(starts,before);
 realPlayer.resume();assert.equal(video.paused,false);assert.equal(appliedRate,2);
 realPlayer.pause();realPlayer.setRate(1);realPlayer.resume();assert.equal(appliedRate,1);
});
realPlayer.stop();await playerTest.settled();delete context.shaka;
// Separate native clock/state from seek callbacks, which can precede keyframe settling.
let prepareNative,nativeListener,nativeTime=0,nativeCalls=[],nativeState='NONE',nativeMuted=false;
let fakeNow=1000,nativeFailMute=false,nativeFailEnable=false;
context.Date=class extends Date{getTime(){return fakeNow;}};context.USER_AGENT='test';
context.webapis={avplay:{close(){nativeState='NONE';},stop(){},open(){nativeState='IDLE';},setDisplayRect(){},
 setStreamingProperty:(k,v)=>nativeCalls.push([k,v]),setVideoStillMode:v=>nativeCalls.push(['still',v]),
 disableAudioStream(){if(nativeFailMute)throw Error('mute unavailable');nativeMuted=true;},
 enableAudioStream(){if(nativeFailEnable)throw Error('enable failed');nativeMuted=false;},
 setListener:l=>{nativeListener=l;},prepareAsync:ok=>{prepareNative=ok;},getDuration:()=>90000,
 getCurrentTime:()=>nativeTime,getState:()=>nativeState,
 getCurrentStreamInfo:()=>[{type:'VIDEO',extra_info:JSON.stringify({Width:'512',Height:'288'})}],
 seekTo(){throw Error('seekTo would snap forward');},play(){nativeState='PLAYING';},
 pause(){assert.ok(['PLAYING','PAUSED'].includes(nativeState));nativeState='PAUSED';},
 setSpeed:r=>{if(nativeState==='PAUSED')nativeTime+=3000;nativeCalls.push(['speed',r]);}}};
node('video-stage').appendChild=()=>{};
function beginNative(target,at=target,paused=true){
 events=[];nativeCalls=[];nativeTime=at;realPlayer.playProgressive('native',target,{paused});prepareNative();
}
function nativeTick(at,elapsed=50){nativeTime=at;fakeNow+=elapsed;fireTimer(50);}
function nativeStatus(){return {state:nativeState,muted:nativeMuted,ready:hasEvent('ready'),error:hasEvent('error')};}
const held={state:'PAUSED',muted:false,ready:true,error:false};
await check('native readiness silently decodes to the actual paused position',()=>{
 beginNative(12345,10067);assert.equal(nativeState,'PLAYING');assert.equal(nativeMuted,true);
 nativeListener.oncurrentplaytime(10067);assert.equal(realPlayer.hasPosition(),false);assert.equal(hasEvent('ready'),false);
 nativeTick(12371);assert.deepEqual(nativeStatus(),held);assert.equal(realPlayer.position(),12371);
 assert.equal(realPlayer.hasPosition(),true);assert.equal(events.filter(e=>e.kind==='time').length,1);
 assert.equal(events.find(e=>e.kind==='quality').data.width,512);
});
await check('native zero and cancelled callbacks cannot inherit a previous position',()=>{
 beginNative(0);assert.deepEqual(nativeStatus(),held);assert.equal(realPlayer.position(),0);
 nativeTime=67;assert.equal(realPlayer.position(),67);assert.deepEqual(nativeCalls.find(c=>c[0]==='PREBUFFER_MODE'),['PREBUFFER_MODE','0']);
 beginNative(12345,10000);const oldPrepare=prepareNative,oldPoll=Array.from(timers.values()).filter(t=>t.ms===50).at(-1).f;
 realPlayer.playProgressive('new',0,{paused:true});events=[];nativeCalls=[];oldPrepare();oldPoll();
 assert.equal(events.length,0);assert.equal(nativeCalls.length,0);nativeTime=0;prepareNative();assert.deepEqual(nativeStatus(),held);
});
await check('native timeout, keyframe overshoot and output failures reject readiness',()=>{
 for(const failure of ['timeout','overshoot','mute','enable']){
  nativeTime=failure==='overshoot'?15067:10000;events=[];nativeCalls=[];nativeFailMute=failure==='mute';
  realPlayer.playProgressive(failure,12345,{paused:true});nativeFailMute=false;prepareNative();
  nativeFailEnable=failure==='enable';
  if(['timeout','enable'].includes(failure))nativeTick(failure==='timeout'?10000:12370,failure==='timeout'?21000:50);
  nativeFailEnable=false;assert.equal(hasEvent('error'),true);assert.equal(hasEvent('ready'),false);
  if(failure==='timeout')assert.equal(nativeMuted,false);
 }
 realPlayer.stop();
});
await check('native pause, resume, speed and retarget share the pending restore',()=>{
 beginNative(12345,10000,false);realPlayer.pause();assert.equal(nativeState,'PLAYING');
 assert.equal(realPlayer.setRate(2),true);assert.equal(realPlayer.setRate(1.5),false);nativeTick(12370);
 assert.deepEqual(nativeStatus(),held);assert.equal(realPlayer.rate(),2);assert.equal(realPlayer.position(),12370);
 assert.equal(nativeCalls.some(c=>c[0]==='speed'&&c[1]===2),false);realPlayer.resume();
 assert.ok(nativeCalls.some(c=>c[0]==='speed'&&c[1]===2));
 beginNative(12345,10000);realPlayer.seekBy(1000);assert.equal(nativeCalls.at(-1)[0],'still');
 assert.ok(nativeCalls.some(c=>c[0]==='PREBUFFER_MODE'&&c[1]==='13345'));
 nativeTime=13350;prepareNative();assert.deepEqual(nativeStatus(),held);realPlayer.setRate(1);
});
await check('legacy native seek validates settled position and ignores late failure',()=>{
 const api=context.webapis.avplay,disable=api.disableAudioStream,seek=api.seekTo;delete api.disableAudioStream;
 api.seekTo=(ms,ok)=>{nativeTime=ms;ok();};beginNative(0);nativeTime=67;fireTimer(200);
 assert.deepEqual(nativeStatus(),held);assert.equal(realPlayer.position(),67);
 events=[];realPlayer.playProgressive('drift',12345,{paused:true,quality:16});prepareNative();nativeTime=15067;fireTimer(200);
 assert.equal(hasEvent('error'),true);assert.equal(hasEvent('ready'),false);const before=events.length;
 nativeListener.onerror('late');assert.equal(events.length,before);api.disableAudioStream=disable;api.seekTo=seek;
});
await check('native live excludes VOD prebuffering and mute',()=>{
 events=[];nativeCalls=[];nativeTime=200000;realPlayer.playLiveNative('live');prepareNative();
 assert.deepEqual(nativeStatus(),{state:'PLAYING',muted:false,ready:true,error:false});
 assert.equal(nativeCalls.some(c=>c[0]==='PREBUFFER_MODE'),false);realPlayer.stop();
});
context.Date=Date;
// The production application is evaluated intact; window.onload is not run.
context.Player={on:f=>eventHandler=f,qualityChoices:d=>d?Mpd.tiers(d,120):[],currentQuality:()=>0,
  selectQuality:()=>false,hasPosition:()=>true,position:()=>42000,userPaused:()=>true,rate:()=>1,
  playDash:(...args)=>calls.push(['dash',...args]),playProgressive:(...args)=>calls.push(['prog',...args])};
let appSource=source('app/js/app.js');
appSource=appSource.replace('    window.onload = function () {',`    window.__controlsTest={
      session: function(s){playing=s;optionsOpen=true;toastEl=el('toast');return s;},
      start: function(d){playing=null;optionsOpen=false;screenEl=el('screen');statusEl=el('status');toastEl=el('toast');
        nextupGrid={clear:function(){}};play(d,d.cid);return playing;},
      scrub: function(dir){moveScrub(dir);commitScrub();},
      seedPosition: function(ms){lastKnownPosition=ms;lastKnownDuration=90000;},
      quality:changeQuality,
      paint:paintPlaybackControls, rollback:restoreQualityChange, ids:controlQualityIds,
      bind:bindPlaybackControls, closeChoices:closePlaybackChoices,
      pause:setPaused, end:function(){optionsOpen=false;beginAutoNext();}
    };
    window.onload = function () {`);
vm.runInContext(appSource,context);
const app=context.__controlsTest;
const session=(extra={})=>{
 calls=[];
 return app.session({detail:{bvid:'BVTEST',title:'test'},cid:1,timed:true,subtitleTracks:[],
   route:'progressive',quality:80,urls:['old'],urlIdx:0,startMs:0,dashReady:dash,...extra});
};
let dashReply,progReply;
context.API.playurlDash=(b,c,q,ok,fail)=>dashReply={ok,fail};
context.API.playurlProgressive=(b,c,q,ok,fail)=>progReply={ok,fail,qn:q};
function prepareQuality(qn,d=dash,p=null){
 app.quality(qn);d?dashReply.ok(d):dashReply.fail('no dash');p?progReply.ok(p):progReply.fail('no prog');
}
await check('quality labels show actual tiers, preserve missing preferences and clear native sizes',()=>{
 Settings.set('preferredQn',120);session({route:'dash'});app.bind();node('panel-quality').onselect();
 assert.equal(node('panel-quality').textContent,'画质 1080p');assert.equal(node('playback-choices').innerHTML.includes('4K'),false);
 assert.match(node('playback-choices').innerHTML,/class="opt focusable current" role="button" data-playback-choice="80"/);
 eventHandler('quality',{id:32,width:640,height:480});assert.equal(node('panel-quality').textContent,'画质 480p');
 assert.equal(Settings.qualityPreference(),120);
 session({route:'dash',quality:120,dashReady:{...dash,video:[rep(120),...dash.video]}});app.bind();
 assert.equal(node('panel-quality').textContent,'画质 4K');assert.equal(Settings.qualityPreference(),120);
 Settings.set('preferredQn',0);app.bind();assert.equal(node('panel-quality').textContent,'画质 自动(4K)');app.closeChoices(false);
 Settings.set('preferredQn',80);const s=session();eventHandler('quality',{width:512,height:288});assert.equal(s.quality,80);
 assert.equal(node('panel-quality').textContent,'画质 288p');eventHandler('quality',{id:32,width:640,height:480});
 assert.equal(s.nativeSize,'');assert.equal(node('panel-quality').textContent,'画质 480p');
});
await check('unprepared playback cannot start a competing load',()=>{
 const s=session({route:null,quality:null,dashReady:null,urls:null});dashReply=progReply=null;
 const before=Settings.qualityPreference();app.quality(0);
 assert.equal(dashReply,null);assert.equal(progReply,null);assert.equal(calls.length,0);
 assert.equal(!!s.qualityBusy,false);assert.equal(Settings.qualityPreference(),before);
});
await check('quality preparation keeps playback alive and preserves paused zero',()=>{
 const s=session();context.Player.position=()=>0;app.quality(32);assert.equal(calls.length,0);
 dashReply.ok(dash);assert.equal(calls.length,0);progReply.fail('none');
 assert.equal(calls[0][0],'dash');assert.equal(calls[0][2],0);assert.equal(calls[0][3].paused,true);
 assert.equal(calls[0][3].quality,32);assert.equal(s.qualityBusy,true);
 eventHandler('ready',{});assert.equal(s.qualityBusy,false);assert.equal(Settings.qualityPreference(),32);
});
await check('failed target restores the original stream, dimensions and preference',()=>{
 const s=session({nativeSize:'512×288'});Settings.set('preferredQn',80);context.Player.position=()=>42000;
 prepareQuality(64);assert.equal(s.nativeSize,'');app.paint();assert.doesNotMatch(node('panel-quality').textContent,/288p/);
 eventHandler('quality',{id:64,width:1280,height:720});eventHandler('error','target failed');
 assert.equal(s.route,'progressive');assert.equal(s.nativeSize,'512×288');assert.equal(Settings.qualityPreference(),80);
 assert.equal(calls.at(-1)[0],'prog');assert.equal(calls.at(-1)[1],'old');assert.equal(calls.at(-1)[3].paused,true);
 dashReply=progReply=null;app.quality(32);assert.equal(dashReply,null);assert.equal(progReply,null);
 eventHandler('quality',{width:512,height:288});eventHandler('ready',{});app.paint();
 assert.equal(node('panel-quality').textContent,'画质 288p');
});
await check('failed target preserves later pause and resume commands',()=>{
 const original=context.Player.userPaused;
 for(const initial of [false,true]){
  let paused=initial;context.Player.userPaused=()=>paused;
  context.Player.pause=()=>{paused=true;};context.Player.resume=()=>{paused=false;};
  session();prepareQuality(32);app.pause(!initial);eventHandler('error','target failed');
  assert.equal(calls.at(-1)[3].paused,!initial);
 }
 context.Player.userPaused=original;
});
await check('end of video cancels quality requests before next-video lookup',()=>{
 context.EpisodeNav={adjacent:()=>null};context.Player.stop=()=>calls.push(['stop']);
 context.API.related=()=>{}; // Hold the next-video request while quality replies arrive.
 for(const autoplay of [false,true]){
  Settings.set('autoplayNext',autoplay);const s=session();app.quality(32);
  const d=dashReply,p=progReply,revision=s.qualityRevision;
  const timer=Array.from(timers.values()).filter(t=>t.ms===35000).at(-1).f;
  app.end();d.ok(dash);p.fail('no progressive');timer();
  assert.deepEqual(calls,[['stop']]);assert.equal(s.qualityBusy,false);
  assert.ok(s.qualityRevision>revision);assert.equal(s.controlTransition,null);
 }
});
await check('actual DASH and native candidates determine quality and automatic mode',()=>{
 let s=session({quality:16});prepareQuality(80,{...dash,video:[rep(16)]},{quality:80,urls:['native-80']});
 assert.equal(calls.at(-1)[0],'prog');assert.equal(calls.at(-1)[1],'native-80');assert.equal(s.quality,80);eventHandler('ready',{});
 s=session({quality:16});app.quality(0);assert.equal(calls.length,0);assert.equal(s.qualityBusy,true);
 dashReply.ok(dash);progReply.ok({quality:64,urls:['native-64']});
 assert.equal(calls.at(-1)[0],'dash');assert.equal(calls.at(-1)[3].quality,0);eventHandler('ready',{});
 assert.equal(Settings.qualityPreference(),0);
 s=session({dashReady:null,quality:16,nativeQualities:[80,16]});assert.deepEqual(Array.from(app.ids()),[80,16]);
 Settings.set('maxQn',32);assert.deepEqual(Array.from(app.ids()),[16]);Settings.set('maxQn',120);
});
await check('Auto and manual changes retain legacy native fallback below its service label',()=>{
 for(const cap of [32,64])for(const qn of [0,cap,80])for(const withDash of [false,true]){
  Settings.set('maxQn',cap);Settings.set('preferredQn',80);
  const s=session({quality:16,dashReady:null,nativeSize:'512×288'});
  prepareQuality(qn,withDash?{...dash,video:[rep(120)]}:null,{quality:80,urls:['legacy']});
  assert.equal(progReply.qn,cap);assert.equal(calls.at(-1)?.[0],'prog');assert.equal(calls.at(-1)[1],'legacy');
  assert.equal(s.quality,80);assert.equal(s.qualityBusy,true);assert.equal(Settings.qualityPreference(),80);
  eventHandler('quality',{width:512,height:288});eventHandler('ready',{});
  assert.equal(Settings.qualityPreference(),qn);assert.equal(s.qualityBusy,false);
  assert.equal(node('panel-quality').textContent,qn?'画质 288p':'画质 自动(288p)');
 }
 Settings.set('maxQn',120);
});
await check('failed preparation keeps the stream; login refusals do not upload incidents',()=>{
 for(const login of [false,true]){
  const s=session(),before=incidents.length;app.quality(64);dashReply.fail('no dash');
  progReply.fail(login?'code -101 账号未登录':'no prog');
  assert.equal(calls.length,0);assert.equal(s.qualityBusy,false);assert.equal(incidents.length,before+Number(!login));
  assert.doesNotMatch(node('toast').textContent,/已恢复/);
  if(login){assert.match(node('toast').textContent,/扫码登录/);assert.doesNotMatch(node('toast').textContent,/-101/);}
 }
});
await check('new video and newer selection invalidate earlier stream responses',()=>{
 session();app.quality(64);let d=dashReply,p=progReply;
 session();d.ok(dash);p.ok({quality:64,urls:['new']});assert.equal(calls.length,0);
 const s=session();app.quality(64);d=dashReply;p=progReply;
 app.rollback('timeout');app.quality(32);const nextD=dashReply,nextP=progReply;
 d.ok(dash);p.fail('old');assert.equal(calls.length,0);nextD.ok(dash);nextP.fail('none');
 assert.equal(calls.length,1);assert.equal(calls[0][3].quality,32);eventHandler('ready',{});assert.equal(s.qualityBusy,false);
});
await check('native-only tiers are fetched before accepting a DASH fallback',()=>{
 const controllerPlayer=context.Player;
 realPlayer.stop();const onlyLow={...low,active:true},onlyDash={...dash,video:[rep(32)]};
 playerTest.set({...engine,getVariantTracks:()=>[onlyLow]});
 context.Player={...controllerPlayer,qualityChoices:realPlayer.qualityChoices,
   currentQuality:realPlayer.currentQuality,selectQuality:realPlayer.selectQuality};
 try{
  for(const nativeAvailable of [true,false]){
   Settings.set('preferredQn',32);
   const s=session({route:'dash',quality:32,qualityReady:true,dashReady:onlyDash,nativeQualities:[80]});
   assert.deepEqual(Array.from(app.ids()),[80,32]);dashReply=progReply=null;
   app.quality(32);assert.equal(dashReply,null);assert.equal(progReply,null);
   app.quality(80);assert.ok(dashReply);assert.ok(progReply);
   assert.equal(Settings.qualityPreference(),32);dashReply.ok(onlyDash);
   if(nativeAvailable)progReply.ok({quality:80,urls:['native-80']});else progReply.fail('unavailable');
   assert.equal(calls.at(-1)[0],nativeAvailable?'prog':'dash');
   assert.equal(s.quality,nativeAvailable?80:32);
   eventHandler('ready',{});assert.equal(s.qualityBusy,false);assert.equal(Settings.qualityPreference(),80);
  }
 }finally{context.Player=controllerPlayer;realPlayer.stop();}
});
await check('paused DASH tail switches leave a fetchable segment and preserve speed and pause',()=>{
 const {media:{SegmentIndex}}=createRequire(import.meta.url)('../app/vendor/shaka-player.compiled.js');
 const getTracks=engine.getVariantTracks,select=engine.selectVariantTrack;
 const index=SegmentIndex.forSingleSegment(0,120,['https://example.invalid/video']);
 let retained;
 engine.getVariantTracks=()=>[active,low];
 engine.selectVariantTrack=(track,clear,margin)=>{
  retained=margin;active.active=track.id===active.id;low.active=track.id===low.id;
 };
 try{
  for(const rate of [1,2])for(const at of [118,119.9]){
   active.active=true;low.active=false;Settings.set('preferredQn',0);playerTest.set(engine);
   Object.assign(video,{currentTime:at,duration:120,paused:true});realPlayer.pause();realPlayer.setRate(rate);
   let done=null;const before=starts;
   assert.equal(realPlayer.selectQuality(32,why=>done=why),true);
   assert.ok(retained>0&&retained<120-at,'retain less than the remaining media');
   // Shaka refills from the retained buffer end. Keeping the entire tail
   // makes its real SegmentIndex return no next segment.
   assert.ok(index.getIteratorForTime(at+retained));assert.equal(index.getIteratorForTime(120),null);
   assert.equal(done,null);sdkListeners.get('segmentappended')({contentType:'audio'});assert.equal(done,null);
   sdkListeners.get('segmentappended')({contentType:'video'});assert.equal(done,'');
   assert.equal(realPlayer.currentQuality(),32);assert.equal(realPlayer.userPaused(),true);
   assert.equal(realPlayer.rate(),rate);assert.equal(starts,before);
  }
 }finally{
  realPlayer.setRate(1);realPlayer.stop();engine.getVariantTracks=getTracks;engine.selectVariantTrack=select;
  video.duration=NaN;video.currentTime=0;
 }
});
await check('startup resolves saved quality across both routes, caps and fresh settings instances',()=>{
 Object.assign(context.Player,{startTiming(){},mark(){},strongHint:()=>0,pickDashVideo:realPlayer.pickDashVideo});
 context.Resume={positionMs:()=>0,markAlive(){}};
 context.Accounts={activeId:()=> 'test'};
 context.Danmaku={area:()=> 'top',areaClass:()=> 'hidden'};
 context.API.gone=()=>assert.fail('startup rejected a usable progressive response');
 let resumeReply,serial=0;context.API.playerV2=(b,c,ok)=>{resumeReply=ok;};
 try{
  for(const [preference,tiers,prog,cap,route,actual] of [
   [80,[120,64],80,120,'prog',80],[80,[120,80,64],80,120,'dash',80],
   [80,[120,64],32,120,'dash',64],[80,[120],64,120,'prog',64],
   [16,[80],32,120,'prog',32],[0,[120,64],80,120,'dash',120],
   [80,[120,64],80,64,'dash',64],[80,[],80,120,'prog',80],
   [80,[64],null,120,'dash',64],[64,[120,64],80,120,'dash',64],
   [0,[],80,32,'prog',80],[32,[],80,32,'prog',80],[80,[],80,32,'prog',80],
   [0,[],80,64,'prog',80],[32,[],80,64,'prog',80],[80,[],80,64,'prog',80],
   [80,[120],80,32,'prog',80]]){
   for(const nativeFirst of [false,true]){
    Settings.set('preferredQn',preference);Settings.set('maxQn',cap);calls=[];
    const fresh=vm.createContext({localStorage:storage});vm.runInContext(source('app/js/settings.js'),fresh);
    context.Settings=fresh.Settings;
    const s=app.start({bvid:'BVSTART'+(++serial),cid:serial,title:'startup',duration:'2:00'});
    const d=()=>tiers.length?dashReply.ok({...dash,video:tiers.map(rep)}):dashReply.fail('unavailable');
    const p=()=>prog?progReply.ok({quality:prog,urls:['native-'+prog]}):progReply.fail('unavailable');
    if(nativeFirst){p();d();}else{d();p();}
    assert.equal(calls.filter(c=>c[0]==='dash'||c[0]==='prog').length,0,'wait for resume before starting');
    assert.equal(progReply.qn,Math.min(preference||cap,cap));
    resumeReply({cid:serial,positionMs:42000,subtitles:[]});
    assert.equal(calls.at(-1)[0],route);assert.equal(s.quality,actual);assert.equal(calls.at(-1)[2],42000);
    assert.equal(fresh.Settings.qualityPreference(),preference);
   }
  }
 }finally{context.Settings=Settings;}
});
await check('native preparation keeps consecutive scrub commits without reporting readiness',()=>{
 const stub=context.Player;context.Player=realPlayer;
 try{
  for(const paused of [false,true])for(const [from,directions,targets] of [
   [42000,[1,1],[52000,62000]],[42000,[1,-1],[52000,42000]],
   [10000,[-1,1],[0,10000]],[78000,[1,1],[88000,88000]]]){
   session({shots:null});app.seedPosition(from);events=[];nativeCalls=[];nativeTime=from;
   realPlayer.playProgressive('scrub-native',from,{paused,quality:32});
   const oldPrepare=prepareNative,oldListener=nativeListener;
   for(let i=0;i<directions.length;i++){
    app.scrub(directions[i]);
    assert.equal(nativeCalls.filter(c=>c[0]==='PREBUFFER_MODE').at(-1)[1],String(targets[i]));
    assert.equal(realPlayer.hasPosition(),false);assert.equal(hasEvent('ready'),false);assert.equal(hasEvent('time'),false);
   }
   oldPrepare();oldListener.oncurrentplaytime(from);assert.equal(events.length,0);
   const target=targets.at(-1);nativeTime=target;prepareNative();
   assert.equal(hasEvent('ready'),true);assert.equal(realPlayer.position(),target);assert.equal(realPlayer.userPaused(),paused);
   realPlayer.stop();
  }
 }finally{realPlayer.stop();context.Player=stub;}
});
await check('quality rollback retains newer scrub targets through native errors and timeouts',()=>{
 const stub=context.Player;context.Player=realPlayer;
 realPlayer.on((kind,data)=>{events.push({kind,data});if(kind==='error')eventHandler(kind,data);});
 try{
  for(const paused of [false,true])for(const failure of ['error','native-timeout','quality-timeout'])
   for(const [from,directions,target] of [[42000,[1],52000],[42000,[1,1],62000],[10000,[-1],0],[42000,[],42000]]){
    Settings.set('maxQn',120);Settings.set('preferredQn',80);
    const s=session({shots:null,dashReady:null});app.seedPosition(from);nativeTime=from;
    realPlayer.playProgressive('old',from,{paused});prepareNative();
    prepareQuality(32,null,{quality:32,urls:['target']});
    for(const dir of directions)app.scrub(dir);
    app.pause(!paused);
    const oldPrepare=prepareNative,oldListener=nativeListener;events=[];
    if(failure==='error')nativeListener.onerror('target failed');
    else fireTimer(failure==='native-timeout'?25000:35000);
    assert.equal(s.startMs,target);assert.equal(s.quality,80);assert.equal(s.qualityBusy,false);
    assert.equal(Settings.qualityPreference(),80);assert.equal(s.controlTransition,null);
    assert.equal(nativeCalls.filter(c=>c[0]==='PREBUFFER_MODE').at(-1)[1],String(target));
    assert.equal(realPlayer.hasPosition(),false);assert.equal(hasEvent('ready'),false);
    oldPrepare();oldListener.oncurrentplaytime(from);oldListener.onerror('late');
    assert.equal(hasEvent('ready'),false);
    nativeTime=target;prepareNative();assert.equal(realPlayer.position(),target);
    assert.equal(realPlayer.userPaused(),!paused);assert.equal(hasEvent('ready'),true);
    realPlayer.stop();
   }
 }finally{realPlayer.stop();context.Player=stub;realPlayer.on((kind,data)=>events.push({kind,data}));}
});
await check('stream recovery cancels pending quality replies and blocks selection until ready',()=>{
 const stub=context.Player;let paused=false;
 context.Player={...stub,startTiming(){},pickDashVideo:realPlayer.pickDashVideo,durationMs:()=>90000,mode:()=>null,
  userPaused:()=>paused,pause:()=>{paused=true;},resume:()=>{paused=false;},stop:()=>{paused=false;calls.push(['stop']);}};
 try{
  for(const initial of [false,true])for(const lateFailure of [false,true])for(const afterReady of [false,true]){
   Settings.set('maxQn',120);Settings.set('preferredQn',32);paused=initial;
   const s=session({route:'dash',quality:32,shots:null,dashReady:{...dash,video:[rep(32)]}});app.seedPosition(42000);
   app.pause(initial);app.quality(80);const manualD=dashReply,manualP=progReply;
   const manualTimer=Array.from(timers.values()).filter(t=>t.ms===35000).at(-1).f;
   eventHandler('error','清单已过期');const recovery=dashReply;
   const late=()=>{
    if(lateFailure){manualD.fail('old dash failure');manualP.fail('old native failure');}
    else{manualD.ok({...dash,video:[rep(32)]});manualP.ok({quality:80,urls:['late-native']});}
    manualTimer();
   };
   if(!afterReady)late();assert.equal(s.qualityBusy,false);assert.equal(s.qualityReady,false);
   assert.deepEqual(calls.map(c=>c[0]),['stop']);assert.equal(Settings.qualityPreference(),32);
   app.quality(80);assert.equal(dashReply,recovery);assert.equal(progReply,manualP);
   app.pause(!initial);app.scrub(1);recovery.ok({...dash,video:[rep(32)]});
   assert.equal(calls.at(-1)[0],'dash');assert.equal(calls.at(-1)[2],52000);
   assert.equal(calls.at(-1)[3].paused,!initial);assert.equal(calls.at(-1)[3].quality,32);
   assert.equal(s.qualityReady,false);eventHandler('ready',{});assert.equal(s.qualityReady,true);
   app.quality(80);assert.notEqual(dashReply,recovery);
   if(afterReady)late();assert.equal(s.qualityBusy,true);assert.deepEqual(calls.map(c=>c[0]),['stop','dash']);
   dashReply.fail('no dash');progReply.fail('no native');assert.equal(s.qualityBusy,false);
  }
 }finally{context.Player=stub;}
});
console.log(`${count}/${count} playback control scenarios passed (controlled media, not device acceptance).`);
