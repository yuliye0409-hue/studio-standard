import test from 'node:test';
import assert from 'node:assert/strict';
import { color, normalizeResult, inspectRegion, enabledLayers, boardFor, dimensions, cleanRaster } from '../lib/reconstruction.js';
import { parseProvider, reconstruct, providerConfig } from '../lib/reconstruction-api.js';
const text = { type: 'TEXT', name: '原文', bbox: [.1,.1,.6,.5], text: 'Exact  文案\n100% <&>', color: '#000', confidence: .95, fontSize: 12, fontWeight: 700, fontFamily: 'Arial', lineHeight: 1.2 };
const layer = () => normalizeResult({ layers: [text] }, 100, 100)[0];
function pixels(draw) { const data = new Uint8ClampedArray(100 * 100 * 4); data.fill(255); const put = (x,y,c) => data.set([...c,255], (y * 100 + x) * 4); draw?.(put); return data; }
test('exact text and original coordinates survive normalization; shorthand/RGB colors are normalized', () => {
  const l = layer(); assert.equal(l.characters, text.text); assert.equal(l.enabled, false); assert.deepEqual([l.x,l.y,l.width,l.height],[10,10,60,50]); assert.equal(l.color,'#000000'); assert.equal(color('rgb(255, 80, 0)'), '#ff5000'); assert.throws(() => color('rgb(999,0,0)')); assert.throws(() => dimensions(16384,16384)); assert.throws(() => normalizeResult({ layers: [{...text,bbox:[.9,0,.5,.5]}] },100,100));
});
test('unfinished manual regions can be backed up but can never clear or replace original pixels',()=>{
  const draft={...text,text:'',manual:true};assert.throws(()=>normalizeResult({layers:[draft]},100,100));
  const l=normalizeResult({layers:[draft]},100,100,{allowIncomplete:true})[0];assert.equal(l.manual,true);assert.equal(l.enabled,false);assert.equal(inspectRegion(pixels(),100,100,l).safe,false);
});
test('flat two-color region can be cleared; photography, alpha, weak confidence and clipped boundaries cannot', () => {
  const l = layer(), p = pixels(put => { for(let y=20;y<40;y++)for(let x=20;x<45;x++)put(x,y,[0,0,0]); });
  assert.equal(inspectRegion(p,100,100,l).safe,true);
  assert.equal(inspectRegion(p,100,100,{...l,characters:''}).safe,false);
  assert.equal(inspectRegion(p,100,100,{...l,confidence:.4}).safe,false);
  p[(20*100+20)*4+3]=180; assert.equal(inspectRegion(p,100,100,l).safe,false);
  const noisy = pixels(put=>{ for(let y=11;y<59;y++)for(let x=11;x<69;x++)put(x,y,[x*3,y*3,100]); });
  assert.equal(inspectRegion(noisy,100,100,l).safe,false);
  assert.equal(inspectRegion(pixels(put=>{for(let x=10;x<70;x++)put(x,10,[0,0,0]);}),100,100,l).safe,false);
});
test('shape extraction verifies geometry rather than converting rounded or textured objects into plain rectangles', () => {
  const shape={id:'s',type:'RECTANGLE',x:20,y:20,width:40,height:30,color:'#000000',confidence:.9};
  const p=pixels(put=>{for(let y=20;y<50;y++)for(let x=20;x<60;x++)put(x,y,[0,0,0]);});
  assert.equal(inspectRegion(p,100,100,shape).safe,true);
  assert.equal(inspectRegion(p,100,100,{...shape,type:'ELLIPSE'}).safe,false);
  p.set([255,255,255,255],(25*100+25)*4);p.set([255,255,255,255],(26*100+25)*4);p.set([255,255,255,255],(27*100+25)*4);
  assert.equal(inspectRegion(p,100,100,shape).safe,false);
});

test('text on a photographic backdrop becomes editable using a foreground mask, not a flat-background gate', () => {
  const p = pixels(put => {
    for (let y=0;y<100;y++) for (let x=0;x<100;x++) put(x,y,[160+x/2,130+y/3,100+x/4]);
    for (let y=20;y<40;y++) for (let x=20;x<45;x++) put(x,y,[0,0,0]);
  });
  const result = inspectRegion(p,100,100,layer());
  assert.equal(result.safe,true); assert.equal(result.method,'inpaint');
  assert.ok(result.mask.some(Boolean)); assert.match(result.reason,/近似/);
});

test('polygon label geometry is retained as native vector paths rather than replaced with a rectangle', () => {
  const l = normalizeResult({layers:[{type:'VECTOR',name:'切角标签',bbox:[.1,.1,.6,.4],color:'#efe5d7',confidence:.96,paths:[{data:'M 0.1 0 L 0.9 0 L 1 0.2 L 1 0.8 L 0.9 1 L 0.1 1 L 0 0.8 L 0 0.2 Z',windingRule:'EVENODD'}]}]},100,100)[0];
  assert.equal(l.type,'VECTOR'); assert.match(l.vectorPaths[0].data,/L 60 8/);
  assert.throws(()=>normalizeResult({layers:[{...text,type:'VECTOR',paths:[{data:'M 0 0 L 2 1 Z'}]}]},100,100),/路径/);
});

test('photo cleanup removes old foreground only within the mask and preserves all other pixels exactly',()=>{
  const p=pixels(put=>{for(let y=0;y<100;y++)for(let x=0;x<100;x++)put(x,y,[160+x/2,130+y/3,100+x/4]);for(let y=20;y<40;y++)for(let x=20;x<45;x++)put(x,y,[0,0,0]);});
  const l=layer(); l.check=inspectRegion(p,100,100,l);l.enabled=true;
  const out=cleanRaster(p,100,100,enabledLayers([l]));
  assert.ok(out[(25*100+25)*4]>150); // old black glyph removed
  for(let y=0;y<100;y++)for(let x=0;x<100;x++) {
    const local=(y-l.y)*l.width+x-l.x;
    if(x<l.x||x>=l.x+l.width||y<l.y||y>=l.y+l.height||!l.check.mask[local])assert.deepEqual(out.slice((y*100+x)*4,(y*100+x)*4+4),p.slice((y*100+x)*4,(y*100+x)*4+4));
  }
});

test('large text cleanup reconstructs the whole text box so a glyph-shaped texture patch is not retained',()=>{
  const p=pixels(put=>{for(let y=0;y<100;y++)for(let x=0;x<100;x++)put(x,y,[160+x/2,130+y/3,100+x/4]);for(let y=20;y<40;y++)for(let x=20;x<45;x++)put(x,y,[0,0,0]);});
  const l=layer();l.check=inspectRegion(p,100,100,l);assert.equal(l.check.mask.every(Boolean),true);
  const out=cleanRaster(p,100,100,[l]);
  let error=0;for(let y=10;y<60;y++)for(let x=10;x<70;x++)error+=Math.abs(out[(y*100+x)*4]-(160+x/2));
  assert.ok(error/3000<5,'background interpolation must remain close to the actual smooth backdrop');
});

test('text inside a label is allowed and the label is below the text in the exported layer stack',()=>{
  const t={...layer(),enabled:true,check:{safe:true}},s={id:'shape',type:'RECTANGLE',x:5,y:5,width:80,height:70,enabled:true,check:{safe:true}};
  assert.deepEqual(enabledLayers([t,s]).map(l=>l.id),['shape',t.id]);
  assert.throws(()=>enabledLayers([t,{...s,x:30}]),/重叠/);
});
test('overlapping clear regions reject export; disabled candidates leave original raster untouched', () => {
  const l=layer(); l.check={safe:true,background:'#ffffff'}; l.enabled=true;
  assert.throws(()=>enabledLayers([l,{...l,id:'other'}]),/重叠/);
  assert.throws(()=>enabledLayers([{...l,check:{safe:false}}]),/检查/);
  const board=boardFor({id:'a',name:'image',width:100,height:100,layers:[{...l,enabled:false}]},'base','original');
  assert.equal(board.nodes.length,2);assert.equal(board.nodes[0].visible,false);assert.equal(board.nodes[1].assetId,'base');assert.equal(board.width,100);
});
test('long image tile positions preserve full original canvas and native text positions',()=>{
  const l={...layer(),enabled:true,check:{safe:true},y:5000};
  const board=boardFor({id:'a',name:'long',width:1500,height:7995,layers:[l]},[{assetId:'b1',x:0,y:0,width:1500,height:4096},{assetId:'b2',x:0,y:4096,width:1500,height:3899}],[]);
  assert.equal(board.height,7995);assert.equal(board.nodes[1].y,4096);assert.equal(board.nodes[2].characters,text.text);assert.equal(board.nodes[2].y,5000);
});
test('JSON and completed SSE parse without depending on upstream transport defaults',()=>{
  const parsed={layers:[text]}, output={output:[{content:[{type:'output_text',text:JSON.stringify(parsed)}]}]};
  assert.deepEqual(parseProvider(JSON.stringify(output),'responses'),parsed);
  assert.deepEqual(parseProvider('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:output})+'\n\n','responses','text/event-stream'),parsed);
  assert.deepEqual(parseProvider('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(parsed)}}]})+'\n\ndata: [DONE]\n\n','chat'),parsed);
  assert.throws(()=>parseProvider('event: error\ndata: {"error":{"message":"private diagnostics"}}\n\n','responses'),/错误事件/);
  assert.throws(()=>parseProvider('data: {"type":"response.output_text.delta","delta":"{}"}\n\n','responses'),/中断/);
  assert.throws(()=>parseProvider('<html>private diagnostics</html>','responses'),/JSON/);
});
test('personal settings are per request and never mutate shared server settings',()=>{
  const defaults={baseUrl:'https://example.com/v1',model:'server-model',key:'server-fixture',protocol:'responses'};
  const personal=providerConfig({useCustom:true,baseUrl:'https://example.org/v1',model:'own-model',key:'personal-fixture',protocol:'chat'},defaults);
  assert.equal(personal.model,'own-model');assert.equal(defaults.model,'server-model');assert.equal(providerConfig({useCustom:false,key:'ignored'},defaults).key,'server-fixture');assert.throws(()=>providerConfig({useCustom:true,baseUrl:'https://u:pass@example.org',model:'x',key:'x',protocol:'chat'},defaults));
});
test('HTTP 524 and network errors never replay a billable POST or expose provider error body',async()=>{
  const defaults={baseUrl:'https://example.com/v1',model:'test-model',key:'private-fixture-token',protocol:'responses'};
  const input={width:100,height:100,image:'data:image/png;base64,iVBORw0KGgo='};let calls=0;
  await assert.rejects(reconstruct(input,defaults,async()=>{calls++;return new Response('private-fixture-token',{status:524});}),e=>/HTTP 524/.test(e.message)&&!e.message.includes('private-fixture-token'));
  assert.equal(calls,1);calls=0;
  await assert.rejects(reconstruct(input,defaults,async()=>{calls++;throw new Error('private-fixture-token');}),/网络/);assert.equal(calls,1);
});
test('successful request uses image input and original dimensions; invalid result does not silently use a template',async()=>{
  const defaults={baseUrl:'https://example.com/v1',model:'test-model',key:'private-fixture-token',protocol:'responses'};
  const input={width:100,height:100,image:'data:image/png;base64,iVBORw0KGgo='};
  const data=await reconstruct(input,defaults,async(url,options)=>{assert.equal(url,'https://example.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.stream,false);assert.equal(body.store,false);assert.equal(body.input[0].content[1].type,'input_image');return new Response(JSON.stringify({output_text:JSON.stringify({layers:[text]})}));});
  assert.equal(data.layers[0].characters,text.text);assert.ok(!JSON.stringify(data).includes(defaults.key));
  await assert.rejects(reconstruct(input,defaults,async()=>new Response('{"output_text":"{}"}')),/layers/);
});
