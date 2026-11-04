import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {composeBoard,parseDesignMd} from '../lib/core.js';
const code=await readFile(new URL('../figma-plugin/code.js',import.meta.url),'utf8');
function host(){
  const nodes=[],messages=[],page={children:[],selection:[]};
  const create=type=>{const n={type,x:0,y:0,width:100,height:100,children:[],removed:false,pluginData:{},setPluginData(k,v){this.pluginData[k]=v;},resize(w,h){this.width=w;this.height=h;},appendChild(child){if(child.parent){child.parent.children.splice(child.parent.children.indexOf(child),1);}this.children.push(child);child.parent=this;},remove(){this.removed=true;this.children.slice().forEach(x=>x.remove());if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);}};n.parent=page;page.children.push(n);nodes.push(n);return n;};
  const figma={showUI(){},ui:{postMessage:x=>messages.push(x)},currentPage:page,viewport:{scrollAndZoomIntoView(){}},notify(){},listAvailableFontsAsync:async()=>[{fontName:{family:'Inter',style:'Regular'}},{fontName:{family:'Inter',style:'Semi Bold'}}],loadFontAsync:async()=>{},createImage:bytes=>({hash:'image-'+bytes.length}),createFrame:()=>create('FRAME'),createRectangle:()=>create('RECTANGLE'),createEllipse:()=>create('ELLIPSE'),createText:()=>create('TEXT')};vm.runInNewContext(code,{figma,__html__:'',Uint8Array,Map,Set});return{figma,nodes,messages};
}
function data(){const tokens=parseDesignMd('---\nname: test\n---\n').tokens;const b=composeBoard({asset:{id:'a',width:600,height:800,hash:'original',name:'product'},copy:{title:'Title',body:'Literal body',detail:''},tokens,width:1080,height:1350,measure:(s,t)=>s.length*t.size*.6,fonts:{title:'Inter',body:'Inter'},id:'b'});return{schema:'studio-standard/2',tokens,boards:[b],assets:{a:{bytes:[1,2,3]}}};}
test('A+ slot coordinates and photo-before-text ordering survive native import',async()=>{
  const h=host(),d=data();d.tokens.aPlus={modules:[{id:'hero',type:'hero',order:1,confidence:.95,template:{imageSlots:[{role:'product',bbox:{x:0,y:0,width:1,height:1}}],textSlots:[{role:'headline',bbox:{x:.6,y:.15,width:.35,height:.65}}]}}]};
  d.boards=[composeBoard({asset:{id:'a',width:1500,height:615,hash:'original',name:'photo'},copy:{title:'Title'},tokens:d.tokens,width:1500,height:615,measure:(s,t)=>s.length*t.size*.6,fonts:{title:'Inter',body:'Inter'},id:'slot-board'})];
  await h.figma.ui.onmessage({type:'import',data:d});assert.equal(h.messages[0].ok,true);
  const frame=h.figma.currentPage.children[0],image=frame.children.find(n=>n.pluginData.sourceAssetId==='a'),text=frame.children.find(n=>n.type==='TEXT');
  assert.equal(text.x,900);assert.equal(text.y,92.25);assert.equal(text.width,525);assert.equal(text.characters,'Title');assert.ok(frame.children.indexOf(image)<frame.children.indexOf(text));
});
test('import creates independent editable native text and image nodes',async()=>{const h=host(),d=data();await h.figma.ui.onmessage({type:'import',data:d});assert.equal(h.messages[0].ok,true);assert.equal(h.figma.currentPage.children.length,1);const f=h.figma.currentPage.children[0];assert.equal(f.children.length,4);assert.deepEqual(f.children.filter(n=>n.type==='TEXT').map(n=>n.characters),['Title','Literal body']);const image=f.children.at(-1);assert.equal(image.fills[0].scaleMode,'FIT');assert.equal(image.pluginData.sourceSHA256,'original');assert.equal(h.messages[0].textCount,2);});
test('validation failure does not create any frames',async()=>{const h=host(),d=data();d.boards[0].nodes.at(-1).x=-100;await h.figma.ui.onmessage({type:'import',data:d});assert.equal(h.messages[0].ok,false);assert.equal(h.nodes.length,0);});
test('mid-import error removes all newly created nodes, not existing work',async()=>{const h=host(),d=data(),existing=h.figma.createFrame();d.boards[0].nodes[1].color='invalid';await h.figma.ui.onmessage({type:'import',data:d});assert.equal(h.messages[0].ok,false);assert.equal(h.figma.currentPage.children.length,1);assert.equal(h.figma.currentPage.children[0],existing);assert.ok(h.nodes.filter(n=>n!==existing).every(n=>n.removed));});


test('reconstruction imports long native coordinates, tiled raster, hidden original and independent ellipse',async()=>{
  const h=host(),png=[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,5,220,0,0,16,0];
  const d={schema:'studio-reconstruction/1',assets:{r:{bytes:png}},boards:[{id:'long',name:'long reference',width:1500,height:7995,nodes:[
    {id:'original',type:'IMAGE',name:'original',assetId:'r',hash:'',x:0,y:0,width:1500,height:4096,visible:false,locked:true},
    {id:'tile',type:'IMAGE',name:'base tile',assetId:'r',hash:'',x:0,y:4096,width:1500,height:3899,locked:true},
    {id:'copy',type:'TEXT',name:'exact text',characters:'原文  Exact 100%',fontFamily:'Arial',fontSize:48,fontWeight:700,lineHeight:1.2,align:'right',color:'#000000',x:60,y:5200,width:1000,height:100},
    {id:'shape',type:'ELLIPSE',name:'shape',color:'#ff5000',x:50,y:5400,width:100,height:100}
  ]}]};
  await h.figma.ui.onmessage({type:'import',data:d});assert.equal(h.messages[0].ok,true);
  const f=h.figma.currentPage.children[0];assert.equal(f.height,7995);assert.equal(f.children[0].visible,false);assert.equal(f.children[0].locked,true);
  assert.equal(f.children[1].y,4096);assert.equal(f.children[2].characters,'原文  Exact 100%');assert.equal(f.children[2].y,5200);assert.equal(f.children[2].textAlignHorizontal,'RIGHT');assert.equal(f.children[3].type,'ELLIPSE');assert.match(h.messages[0].notes.join(' '),/字体替换/);
});
test('Figma rejects oversized raster resources before creating long-image frames',async()=>{
  const h=host(),png=[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,5,220,0,0,31,59];
  await h.figma.ui.onmessage({type:'import',data:{schema:'studio-reconstruction/1',assets:{r:{bytes:png}},boards:[{width:1500,height:7995,nodes:[]}]}});assert.equal(h.messages[0].ok,false);assert.match(h.messages[0].message,/4096/);assert.equal(h.nodes.length,0);
});
test('font-loading failure removes only frames created by this import',async()=>{
  const h=host(),existing=h.figma.createFrame();h.figma.loadFontAsync=async()=>{throw new Error('font unavailable');};
  await h.figma.ui.onmessage({type:'import',data:data()});assert.equal(h.messages[0].ok,false);assert.equal(h.figma.currentPage.children.length,1);assert.equal(h.figma.currentPage.children[0],existing);
});
