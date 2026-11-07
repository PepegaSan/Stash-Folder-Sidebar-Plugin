// Minimal hooks/DOM adapter for exercising the classic plugin's real component and callbacks.
// Stash UI is tested with its native DOM implementation; classic host APIs are mocked here.
let cells=[],cursor=0,effects=[],component,props,scheduled=false,patch,settingsPatch;
const eq=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
function schedule(){if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;render();});}}
const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
  useState:init=>{const i=cursor++;if(!cells[i])cells[i]={value:typeof init==='function'?init():init};const c=cells[i];return [c.value,v=>{const n=typeof v==='function'?v(c.value):v;if(!Object.is(n,c.value)){c.value=n;schedule();}}];},
  useRef:value=>{const i=cursor++;return (cells[i]||(cells[i]={current:value}));},
  useEffect:(fn,deps)=>{const i=cursor++;const previous=cells[i];if(!previous||!eq(previous.deps,deps)){cells[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[i].cleanup=fn();});}},
  useCallback:(fn,deps)=>{const i=cursor++;if(!cells[i]||!eq(cells[i].deps,deps))cells[i]={deps,value:fn};return cells[i].value;}
};
function dom(node){
  if(node==null||typeof node==='boolean')return document.createTextNode('');
  if(typeof node!=='object')return document.createTextNode(String(node));
  if(node.type==='portal'){node.props.host.replaceChildren(dom(node.children[0]));return document.createTextNode('');}
  if(typeof node.type==='function')return dom(node.type({...node.props,children:node.children}));
  const el=typeof node.type==='symbol'?document.createDocumentFragment():document.createElement(node.type);
  for(const [k,v] of Object.entries(node.props)){
    if(k==='ref'){if(v)v.current=el;}else if(k==='className')el.className=v;
    else if(k==='style'&&v)Object.assign(el.style,v);
    else if(k.startsWith('on')&&typeof v==='function')el.addEventListener(k==='onDoubleClick'?'dblclick':k.slice(2).toLowerCase(),v);
    else if(!['key','children'].includes(k)&&v!=null){if(k==='disabled'||k==='hidden')el[k]=v;else el.setAttribute(k,String(v));}
  }
  for(const child of node.children)el.append(dom(child));return el;
}
function render(){if(!component)return;cursor=0;effects=[];const tree=component(props);document.getElementById('root').replaceChildren(dom(tree));for(const effect of effects)effect();}
let cachedConfig, cachedData;
const configData=()=>{
  if(cachedConfig!==testConfig){cachedConfig=testConfig;cachedData={configuration:{plugins:{quickMarkers:{presetsJson:JSON.stringify(testConfig)}}}};}
  return cachedData;
};
const toast={success:text=>testState.toasts.push(text),error:text=>testState.toasts.push(text)};
const create=({variables})=>testGql('sceneMarkerCreate',variables);
const find=async({variables})=>({data:await testGql('findTags',variables)});
const keys={};
window.PluginApi={React,ReactDOM:{createPortal:(node,host)=>({type:'portal',props:{host},children:[node]})},
  GQL:{useConfigurationQuery:()=>({data:configData()}),useFindTagsLazyQuery:()=>[find],useSceneMarkerCreateMutation:()=>[create]},
  hooks:{useToast:()=>toast,useSettings:()=>({plugins:configData().configuration.plugins,interface:{language:'de'},loading:false,savePluginSettings:(_,settings)=>saveTestConfig(JSON.parse(settings.presetsJson))})},utils:{InteractiveUtils:{getPlayer:()=>({currentTime:t=>t==null?testVideo.currentTime:(testVideo.currentTime=t),pause:()=>testVideo.pause()})}},
  libraries:{Mousetrap:{bind:(key,fn)=>keys[key]=fn,unbind:key=>delete keys[key]}},
  patch:{after:(name,fn)=>{if(name==='ScenePage')patch=fn;},before:()=>{},instead:(name,fn)=>{if(name==='PluginSettings')settingsPatch=fn;}}
};
function findComponent(node){if(node?.type?.name==='QuickMarkersSceneHook')return node;for(const c of node?.children||[]){const result=findComponent(c);if(result)return result;}}
window.mountClassic=id=>{for(const cell of cells)cell?.cleanup?.();cells=[];const node=findComponent(patch({scene:{id}},null));component=node.type;props=node.props;render();};
window.testClassicKey=(key,repeat=false)=>keys[key]?.({repeat,preventDefault(){}});

window.mountClassicSettings=()=>{
  for(const cell of cells)cell?.cleanup?.();cells=[];
  const tree=settingsPatch({pluginID:'quickMarkers'},()=>null);
  const find=node=>node?.type?.name==='QuickMarkersSettings'?node:(node?.children||[]).map(find).find(Boolean);
  const node=find(tree);component=node.type;props=node.props;render();
};
