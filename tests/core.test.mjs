import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDesignMd, measurePixels, buildAnalysisMd, buildDesignSystem, extractLayoutEvidence, extractAPlusModules, composeBoard, validateBoard, wrapText, contrast } from '../lib/core.js';

const md = (bg = '#ffffff', mode = 'stack') => `---\nname: Test\ncolors:\n  canvas: '${bg}'\n  ink: '#1d1d1f'\n  primary: '#0066cc'\ntypography:\n  display: {fontFamily: Inter, fontSize: 80px, fontWeight: 600}\n  body: {fontFamily: Inter, fontSize: 32px, fontWeight: 400}\nlayout: {mode: ${mode}, baseWidth: 1080}\n---\n# Test`;
const measure = (text, style) => [...text].length * style.size * .62;
const asset = {id:'product',name:'真实原图.png',hash:'sha-original',width:600,height:800};
const copy = {title:'精确标题 🌱',body:'第一行\n第二行：100% / & <test>   空格',detail:'¥299 · 型号 001'};
const board = (mode='stack',width=1080,height=1350,extra={}) => composeBoard({asset,copy,tokens:parseDesignMd(md('#ffffff',mode)).tokens,width,height,measure,fonts:{title:'Inter',body:'Inter'},id:'b',...extra});

test('user Apple specification parses without rewriting colors/type',async()=>{
  const original=await readFile(new URL('../UI-DESIGN.md',import.meta.url),'utf8');
  const {tokens}=parseDesignMd(original); assert.equal(tokens.colors.background,'#ffffff'); assert.equal(tokens.colors.accent,'#0066cc'); assert.equal(tokens.typography.title.size,56); assert.equal(tokens.typography.body.size,17);
});
test('malformed or cyclic design tokens fail explicitly',()=>{
  assert.throws(()=>parseDesignMd('# text only'),/YAML/);
  assert.throws(()=>parseDesignMd(md().replace('#ffffff','oops')),/颜色/);
  assert.throws(()=>parseDesignMd("---\ncolors: {canvas: '{colors.canvas}'}\n---\n"),/循环/);
  assert.throws(()=>parseDesignMd(md().replace('mode: stack','mode: unsupported')),/mode/);
});
test('referenced colors and low contrast are real',()=>{
  const x=parseDesignMd("---\ncolors: {canvas: '#eee', ink: '{colors.canvas}'}\n---\n");assert.equal(x.tokens.colors.background,'#eeeeee');assert.equal(x.warnings.length,1); assert.ok(contrast('#000000','#ffffff')>20);
});
function reference(color){const a=new Uint8ClampedArray(40*40*4);for(let i=0;i<a.length;i+=4){a.set([...color,255],i);}for(let y=12;y<30;y++)for(let x=10;x<30;x++)a.set([0,0,0,255],(y*40+x)*4);return {id:'ref',name:'参考',width:40,height:40,hash:color.join('-'),analysis:measurePixels(a,40,40)};}

test('legacy OCR cannot affect new evidence, typography, module boundaries or exported design system',()=>{
  const clean=reference([230,80,90]),dirty=structuredClone(clean);
  dirty.ocr={text:'OCR_GARBAGE',confidence:99,lines:[{text:'OCR_GARBAGE',confidence:99,relativeHeight:.18,centerX:.1,bbox:{x0:0,y0:0,x1:30,y1:8}}]};
  dirty.evidence={elements:[{id:'text-1',role:'headline',text:'OCR_GARBAGE',bbox:{x:0,y:0,width:.8,height:.2,confidence:.99,source:'ocr'}}],layout:{align:'left',safeArea:.18}};
  assert.deepEqual(extractLayoutEvidence(dirty),extractLayoutEvidence(clean));
  assert.deepEqual(extractAPlusModules(dirty),extractAPlusModules(clean));
  assert.equal(buildAnalysisMd([dirty],'Same'),buildAnalysisMd([clean],'Same'));
  assert.doesNotMatch(JSON.stringify(buildDesignSystem([dirty])),/OCR_GARBAGE/);
});

test('OCR-derived imported standards require reanalysis but hand-authored MD stays usable',()=>{
  const legacy=md().replace('name: Test','name: Test\nsource: {mode: local}\nanalysis: {method: measurement+ocr+human-review}');
  assert.equal(parseDesignMd(legacy).requiresReanalysis,true);
  assert.ok(parseDesignMd(legacy).warnings.some(w=>w.includes('重新分析')));
  assert.equal(parseDesignMd(md()).requiresReanalysis,false);
});
test('different reference pixels produce different analysis MD and tokens',()=>{
  const red=reference([230,80,90]),blue=reference([40,100,220]);
  assert.equal(red.analysis.background,'#e6505a'); assert.ok(red.analysis.occupancy>.2);
  const a=buildAnalysisMd([red],'A'),b=buildAnalysisMd([blue],'B');assert.notEqual(a,b);assert.notEqual(parseDesignMd(a).tokens.colors.background,parseDesignMd(b).tokens.colors.background);assert.match(a,/推测/);assert.doesNotMatch(a,/OCR Evidence|OCR/);assert.throws(()=>buildAnalysisMd([],'x'));
});
test('analysis uses model evidence, ignores OCR and exports a machine-readable design system',()=>{
  const ref=reference([230,80,90]);ref.ocr={confidence:91,lines:[{text:'OCR_GARBAGE',confidence:92,relativeHeight:.09,centerX:.2,bbox:{x0:20,y0:30,x1:340,y1:80}}]};
  ref.evidence={elements:[{id:'vision-1',role:'headline',text:'',bbox:{x:.1,y:.1,width:.4,height:.1,confidence:.92,source:'vision'}}]};
  const evidence=extractLayoutEvidence(ref);assert.equal(evidence.elements[0].role,'headline');assert.equal(evidence.elements[0].bbox.source,'vision');assert.ok(evidence.elements[0].bbox.x<.6);
  const system=buildDesignSystem([ref]);assert.equal(system.version,'design-system/2');assert.equal(system.references[0].evidence.elements.length,1);
  const visual={description:'Model visual analysis',references:[{index:0,elements:[],modules:[]}],colors:{},layout:{}};
  const md=buildAnalysisMd([ref],'Evidence','vision',visual);assert.match(md,/Evidence Map/);assert.match(md,/confidence/);assert.equal(parseDesignMd(md).document.analysis.method,'multimodal+measurement+human-review');assert.doesNotMatch(md,/OCR_GARBAGE|OCR Evidence/);
});
test('long A+ references without reliable structure are not divided into invented equal sections',()=>{
  const ref={...reference([230,80,90]),width:1500,height:7995,evidence:{elements:[]}};
  const spec=extractAPlusModules(ref);assert.equal(spec.moduleCount,1);assert.equal(spec.modules[0].source,'unsegmented-image');assert.equal(spec.modules[0].confidence,.15);assert.equal(spec.modules[0].template.imageSlots.length,0);
});
test('model-provided A+ module and slot geometry is preserved in the reusable specification',()=>{
  const ref={...reference([230,80,90]),aPlusModules:[{type:'image-text-split',bbox:[.05,.2,.9,.3],confidence:.92,reason:'左右分栏',imageSlots:[{role:'product',bbox:[.02,.1,.55,.8]}],textSlots:[{role:'headline',bbox:[.62,.2,.32,.18],maxLines:2,required:true}]}]};
  const spec=extractAPlusModules(ref);assert.equal(spec.moduleCount,1);assert.equal(spec.modules[0].source,'vision');assert.deepEqual([spec.modules[0].x,spec.modules[0].y,spec.modules[0].width,spec.modules[0].height],[.05,.2,.9,.3]);assert.deepEqual(spec.modules[0].template.imageSlots[0].bbox,{x:.02,y:.1,width:.55,height:.8,confidence:.5,source:'vision'});assert.equal(spec.modules[0].template.textSlots[0].required,true);
});
test('wrapping preserves spaces, Chinese, emoji and all original characters',()=>{
  for(const text of ['中文👨‍👩‍👧‍👦 xyz  123\n下一行','\n\n',' a   b ','A\r\nB']){
    const lines=wrapText(text,12,s=>[...s].length*8);assert.equal(lines.join(''),text.replace(/\r?\n/g,''));
  }
});
for(const mode of ['stack','split','image-top'])for(const [w,h] of [[1080,1350],[1080,1080],[1920,1080],[1080,1920],[375,667]])test(`${mode} ${w}x${h}: copy, geometry, ratio and hash preserved`,()=>{
  const b=board(mode,w,h);const report=validateBoard(b,asset);assert.deepEqual(report.errors,[]);assert.equal(report.ok,true);assert.equal(b.nodes.filter(n=>n.type==='TEXT').length,3);assert.equal(b.nodes.find(n=>n.role==='body').characters,copy.body);assert.equal(b.nodes.at(-1).hash,asset.hash);
});
test('no invented CTA, marketing copy or empty extra nodes',()=>{
  const b=board('stack',1080,1350,{copy:{title:'Only provided title',body:'',detail:''}});assert.equal(b.nodes.length,3);assert.deepEqual(b.nodes.filter(n=>n.type==='TEXT').map(n=>n.characters),['Only provided title']);
});
test('brand logo is an independent image layer and never invalidates product hash',()=>{
  const logo={id:'logo',name:'brand.png',hash:'logo-hash',width:400,height:100};const b=board('stack',1080,1350,{brandLogo:logo});const brand=b.nodes.find(n=>n.role==='brand-logo');assert.ok(brand);assert.equal(brand.hash,'logo-hash');assert.equal(brand.assetId,'logo');assert.equal(validateBoard(b,asset).ok,true);assert.ok(b.nodes.find(n=>n.type==='IMAGE'&&n.role!=='brand-logo'));
});
test('MD parameter changes actually affect generated nodes',()=>{
  const a=board(),tokens=parseDesignMd(md('#112233','split')).tokens,b=board('stack',1080,1350,{tokens});assert.notEqual(a.nodes[0].color,b.nodes[0].color);assert.notEqual(a.nodes.at(-1).x,b.nodes.at(-1).x);
});
test('invalid and excessive input fails rather than truncating',()=>{
  assert.throws(()=>board('stack',1080,1350,{copy:{title:''}}),/标题/);assert.throws(()=>board('stack',1080,1350,{copy:{title:'长'.repeat(15000)}}),/未被删减/);assert.throws(()=>board('stack',200,200),/320/);
});
test('validation rejects tampered text, ratio, hash, bounds and overlap',()=>{
  const b=board();b.nodes[1].characters='wrong';b.nodes.at(-1).hash='wrong';b.nodes.at(-1).x=-30;assert.equal(validateBoard(b,asset).ok,false);
  const c=board();c.nodes.at(-1).x=c.nodes[1].x;c.nodes.at(-1).y=c.nodes[1].y;assert.match(validateBoard(c,asset).errors.join(),/重叠/);
});

const moduleSpec=(id,image,text)=>({id,order:1,type:'image-text-split',source:'vision',confidence:.95,sourceCanvas:{width:1500,height:615},x:0,y:0,width:1,height:1,template:{imageSlots:[{id:'photo',role:'product',bbox:image}],textSlots:[{id:'heading',role:'headline',bbox:text,required:true}]}});
const moduleTokens=()=>({...parseDesignMd(md()).tokens,aPlus:{modules:[moduleSpec('left-photo',{x:.03,y:.1,width:.59,height:.8},{x:.67,y:.2,width:.3,height:.5})]}});

test('1500x615 wide uploaded image fits with large reference margins without losing copy',()=>{
  const tokens=parseDesignMd(md()).tokens;tokens.layout.padding=.18;tokens.layout.imageFraction=.72;
  const original={...asset,name:'RGB1.png',width:2928,height:1200};
  const result=board('stack',1500,615,{asset:original,tokens,copy:{title:'HIGH QUALITY KEYCAPS',body:'',detail:''}});
  assert.equal(validateBoard(result,original).ok,true);assert.equal(result.nodes.find(n=>n.type==='TEXT').characters,'HIGH QUALITY KEYCAPS');
});

test('STEP3 actually uses A+ image and text slots instead of generic stack',()=>{
  const original={...asset,width:1800,height:1000},result=board('stack',1500,615,{asset:original,tokens:moduleTokens(),copy:{title:'HIGH QUALITY KEYCAPS'}});
  const title=result.nodes.find(n=>n.role==='title'),image=result.nodes.find(n=>n.type==='IMAGE');
  assert.ok(Math.abs(title.x-1005)<1e-8);assert.equal(title.width,450);assert.ok(image.x+image.width<=930.01);assert.equal(result.layoutMatch.moduleId,'left-photo');assert.equal(validateBoard(result,original).ok,true);
});

test('matching uses actual uploaded aspect ratio, not upload order or filename',()=>{
  const tokens=moduleTokens();tokens.aPlus.modules.push(moduleSpec('portrait-photo',{x:.03,y:.1,width:.15,height:.8},{x:.67,y:.2,width:.3,height:.5}));
  const wide=board('stack',1500,615,{asset:{...asset,width:2400,height:800},tokens,copy:{title:'Wide'}});
  const portrait=board('stack',1500,615,{asset:{...asset,name:'same-name.png',width:400,height:900},tokens,copy:{title:'Portrait'}});
  assert.equal(wide.layoutMatch.moduleId,'left-photo');assert.equal(portrait.layoutMatch.moduleId,'portrait-photo');
  const manual=board('stack',1500,615,{asset:{...asset,width:400,height:900},tokens,copy:{title:'Portrait'},moduleKey:'0:left-photo'});
  assert.equal(manual.layoutMatch.moduleId,'left-photo');
});

test('module text fields and original bytes stay mapped through native editable nodes',()=>{
  const tokens=moduleTokens();tokens.aPlus.modules[0].template.textSlots=[{id:'title',role:'headline',bbox:{x:.65,y:.1,width:.32,height:.2},required:true},{id:'body',role:'body',bbox:{x:.65,y:.35,width:.32,height:.3}},{id:'detail',role:'price',bbox:{x:.65,y:.75,width:.32,height:.15}}];
  const result=board('stack',1500,615,{tokens,copy:{title:'KEYCAPS',body:'中文 English\n100%  空格',detail:'Model A'}});
  assert.equal(result.layoutMatch.kind,'module');assert.equal(validateBoard(result,asset).ok,true);
  for(const field of ['title','body','detail'])assert.equal(result.nodes.find(n=>n.role===field).characters,result.copy[field]);
  assert.equal(result.nodes.find(n=>n.type==='IMAGE').hash,asset.hash);
});

test('auto matching tries a fitting text slot and never hides genuine module overflow',()=>{
  const tokens=moduleTokens();tokens.aPlus.modules[0].template.textSlots[0].bbox.height=.001;
  assert.throws(()=>board('stack',1500,615,{tokens,copy:{title:'KEYCAPS'}}),/没有可容纳.*槽位/);
  tokens.aPlus.modules.push(moduleSpec('fits',{x:.03,y:.1,width:.59,height:.8},{x:.67,y:.2,width:.3,height:.5}));
  assert.equal(board('stack',1500,615,{tokens,copy:{title:'KEYCAPS'}}).layoutMatch.moduleId,'fits');
  assert.throws(()=>board('stack',1500,615,{tokens,copy:{title:'KEYCAPS'},moduleKey:'0:left-photo'}),/文案未被删减/);
  assert.throws(()=>board('stack',1500,615,{tokens,copy:{title:'KEYCAPS',body:'must retain'}}),/缺少正文槽位/);
});

test('missing geometry, low confidence and multi-image modules are not presented as successful reuse',()=>{
  for(const kind of ['missing','low','multiple']){const tokens=moduleTokens(),m=tokens.aPlus.modules[0];if(kind==='missing')m.template.imageSlots=[];if(kind==='low')m.confidence=.2;if(kind==='multiple')m.template.imageSlots.push({...m.template.imageSlots[0],id:'second'});const result=board('stack',1500,615,{tokens,copy:{title:'KEYCAPS'}});assert.equal(result.layoutMatch.kind,'generic');assert.ok(result.warnings.some(x=>x.includes('通用版式')));}
});

test('reference-declared photo/text overlays render image behind text; tampered geometry still fails',()=>{
  const tokens=moduleTokens();tokens.aPlus.modules[0].template.imageSlots[0].bbox={x:0,y:0,width:1,height:1};
  const original={...asset,width:1500,height:615},result=board('stack',1500,615,{asset:original,tokens,copy:{title:'KEYCAPS'}});
  assert.equal(result.layoutMatch.kind,'module');assert.equal(result.nodes[1].type,'IMAGE');assert.equal(validateBoard(result,original).ok,true);
  result.nodes.find(n=>n.type==='TEXT').x=0;assert.match(validateBoard(result,original).errors.join(),/槽位/);
});

test('brand logo gets a free position without hiding reference-slot text or the product',()=>{
  const original={...asset,width:2928,height:1200},tokens=moduleTokens(),brandLogo={id:'logo',name:'brand.png',hash:'logo-hash',width:320,height:80};
  const result=board('stack',1500,615,{asset:original,tokens,brandLogo,copy:{title:'HIGH QUALITY KEYCAPS'}});
  assert.equal(result.layoutMatch.kind,'module');assert.equal(validateBoard(result,original).ok,true);
  const logo=result.nodes.find(n=>n.role==='brand-logo'),title=result.nodes.find(n=>n.role==='title');logo.x=title.x;logo.y=title.y;
  assert.match(validateBoard(result,original).errors.join(),/重叠/);
});

test('wide generic banner accommodates logo plus all three copy fields without corrupting dimensions',()=>{
  const tokens=parseDesignMd(md()).tokens;tokens.layout.padding=.18;tokens.layout.imageFraction=.72;
  const original={...asset,width:2928,height:1200},brandLogo={id:'logo',name:'brand.png',hash:'logo-hash',width:320,height:80};
  const result=board('stack',1500,615,{asset:original,tokens,brandLogo,copy:{title:'HIGH QUALITY KEYCAPS',body:'Original content. No crop.',detail:'Model A'}});
  assert.equal(validateBoard(result,original).ok,true);assert.deepEqual([result.width,result.height],[1500,615]);assert.ok(result.warnings.some(s=>s.includes('重新分配')));
});

test('analysis MD round trip keeps reference dimensions and drives actual slot placement',()=>{
  const ref={...reference([230,80,90]),width:1500,height:7995,aPlusModules:[{type:'image-text-split',bbox:[0,.2,1,.077],confidence:.95,imageSlots:[{role:'product',bbox:[.02,.1,.6,.8]}],textSlots:[{role:'headline',bbox:[.67,.1,.3,.8]}]}]};
  const analysisMd=buildAnalysisMd([ref],'Round trip'),tokens=parseDesignMd(analysisMd).tokens;
  assert.deepEqual(tokens.aPlus.modules[0].sourceCanvas,{width:1500,height:7995});
  const result=board('stack',1500,615,{tokens,copy:{title:'KEYCAPS'}});assert.equal(result.layoutMatch.kind,'module');assert.ok(Math.abs(result.nodes.find(n=>n.role==='title').x-1005)<1e-8);
});
