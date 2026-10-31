import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDesignMd, measurePixels, buildAnalysisMd, buildDesignSystem, extractLayoutEvidence, composeBoard, validateBoard, wrapText, contrast } from '../lib/core.js';

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
test('different reference pixels produce different analysis MD and tokens',()=>{
  const red=reference([230,80,90]),blue=reference([40,100,220]);
  assert.equal(red.analysis.background,'#e6505a'); assert.ok(red.analysis.occupancy>.2);
  const a=buildAnalysisMd([red],'A'),b=buildAnalysisMd([blue],'B');assert.notEqual(a,b);assert.notEqual(parseDesignMd(a).tokens.colors.background,parseDesignMd(b).tokens.colors.background);assert.match(a,/推测/);assert.match(a,/未启用 OCR/);assert.throws(()=>buildAnalysisMd([],'x'));
});
test('analysis creates coordinate evidence and a machine-readable design system',()=>{
  const ref=reference([230,80,90]);ref.ocr={confidence:91,lines:[{text:'Hero title',confidence:92,relativeHeight:.09,centerX:.2,bbox:{x0:20,y0:30,x1:340,y1:80}}]};
  const evidence=extractLayoutEvidence(ref);assert.equal(evidence.elements[0].role,'headline');assert.equal(evidence.elements[0].bbox.source,'ocr');assert.ok(evidence.elements[0].bbox.x<.6);const system=buildDesignSystem([ref]);assert.equal(system.version,'design-system/1');assert.equal(system.references[0].evidence.elements.length, evidence.elements.length);const md=buildAnalysisMd([ref],'Evidence');assert.match(md,/Evidence Map/);assert.match(md,/confidence/);assert.equal(parseDesignMd(md).document.analysis.method,'measurement+ocr+human-review');
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
