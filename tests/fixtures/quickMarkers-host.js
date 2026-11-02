// A small host adapter. All GraphQL writes are test doubles; no Stash is contacted.
window.testState = { markers: [], fail: false, hold: false, tags: ['Compilation', 'Favourite'], toasts: [], reloads: 0 };
window.testConfig = { defaultPresetIndex: 0, panelCollapsed: new URLSearchParams(location.search).has('collapsed') ? true : undefined, touchControls: new URLSearchParams(location.search).has('touch') ? 'on' : 'off', presets: [
  { id:'compilation', label:'Compilation', primaryTag:'Compilation', title:'Compilation', rangeInKey:'shift+i',rangeOutKey:'shift+o',instantKey:'shift+m',selectSlot:1 },
  { id:'favourite', label:'Favourite', primaryTag:'Favourite', title:'Favourite', rangeInKey:'shift+i',rangeOutKey:'shift+o',instantKey:'shift+m',selectSlot:2 },
  { id:'missing', label:'Missing tag', primaryTag:'Missing', title:'Missing', rangeInKey:'shift+i',rangeOutKey:'shift+o',instantKey:'shift+m',selectSlot:3 }
] };
window.testVideo = Object.assign(new EventTarget(), { currentTime:12, pause(){ testState.paused=true; } });
document.getElementById('position').oninput=e=>{ testVideo.currentTime=Number(e.target.value);testVideo.dispatchEvent(new Event('timeupdate')); };
window.testGql = async (query,vars) => {
  if(query.includes('configuration')) return {configuration:{plugins:{quickMarkers:{presetsJson:JSON.stringify(testConfig)}}}};
  if(query.includes('findTags')) {const name=(vars.tf||vars.tag_filter).name?.value; return {findTags:{tags:testState.tags.filter(x=>x===name).map(x=>({id:x,name:x}))}};}
  if(query.includes('tagCreate')) {testState.tags.push(vars.i.name);return {tagCreate:{id:vars.i.name}};}
  if(query.includes('sceneMarkerCreate')) {
    if(testState.hold) await new Promise(resolve=>window.releaseSave=resolve);
    if(testState.fail) {testState.fail=false;throw Error('Test: Speichern fehlgeschlagen');}
    testState.markers.push(vars.input);return {sceneMarkerCreate:{id:String(testState.markers.length)}};
  }
  throw Error('Unexpected mock query: '+query);
};
const dictionaries={};let sceneSlot;let currentController;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
window.testStashUI={ has:x=>x==='slot:scene.info', ui:{esc,icon:()=>'',toast:(text,type,action)=>{testState.toasts.push(text);testState.action=action;},errorToast:e=>testState.toasts.push(e.message)},
  t:(text,vars)=>{let s=dictionaries.de?.[text]||text;for(const [k,v] of Object.entries(vars||{}))s=s.replaceAll('{'+k+'}',v);return s;},
  addStrings:(lang,strings)=>{dictionaries[lang]=strings;},on:()=>{},gql:testGql,addSlot:(name,slot)=>{sceneSlot=slot;}
};
window.mountStashUI=id=>{currentController?.abort();currentController=new AbortController();sceneSlot.mount(document.getElementById('root'),{id,kind:'scene',signal:currentController.signal,video:testVideo,time:()=>testVideo.currentTime,reload:()=>{testState.reloads++;mountStashUI(id);}});};
