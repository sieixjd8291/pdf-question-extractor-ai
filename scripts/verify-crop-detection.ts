import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectDocumentSpreadFromField, prepareEdgeFieldFromPixels, isSaneQuad } from '../src/lib/edgeDetector';
import type { ScanQuad } from '../src/lib/scannerFilters';

const keys = ['tl', 'tr', 'br', 'bl'] as const;
export const fixtures = [
  { name: 'clean', points: '140,110 850,110 850,900 140,900', paper: '#eeeeeb', background: '#55555b' },
  { name: 'perspective', points: '190,80 880,170 790,930 100,830', paper: '#f4f0df', background: '#343b3e' },
  { name: 'low contrast', points: '140,110 850,110 850,900 140,900', paper: '#dddcd9', background: '#c3c2bf' },
  { name: 'dark paper', points: '140,110 850,110 850,900 140,900', paper: '#45414d', background: '#d6d4d0' },
  { name: 'colored paper', points: '140,110 850,110 850,900 140,900', paper: '#be7055', background: '#59766c' },
  { name: 'near frame', points: '8,8 990,8 990,990 8,990', paper: '#eeeeeb', background: '#55555b' },
  { name: 'frame touching', points: '0,0 850,0 850,900 0,900', paper: '#eeeeeb', background: '#55555b' },
  { name: 'receipt', points: '380,40 610,70 630,970 350,930', paper: '#eeeeeb', background: '#55555b' },
  { name: 'text and table', points: '140,110 850,110 850,900 140,900', paper: '#eeeeeb', background: '#55555b', text: true },
  { name: 'shadow', points: '140,110 850,110 850,900 140,900', paper: '#eeeeeb', background: '#55555b', shadow: true },
  { name: 'textured', points: '140,110 850,110 850,900 140,900', paper: '#eeeeeb', background: '#55555b', texture: true },
  { name: 'spread', points: '50,150 950,130 940,850 70,860', paper: '#eeeeeb', background: '#55555b', spread: true },
];

export async function fixturePixels(f: typeof fixtures[number], size = 1800) {
  const texture = f.texture ? Array.from({length:60}, (_,i)=>`<path d="M0 ${i*20} L1000 ${i*20-180}" stroke="#777" stroke-width="3"/>`).join('') : '';
  const text = f.text ? Array.from({length:22}, (_,i)=>`<path d="M180 ${160+i*30} H790" stroke="#222" stroke-width="4"/>`).join('') + '<rect x="180" y="155" width="610" height="690" fill="none" stroke="#222" stroke-width="5"/>' : '';
  const svg = `<svg width="1000" height="1000" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="p"><polygon points="${f.points}"/></clipPath></defs><rect width="1000" height="1000" fill="${f.background}"/>${texture}${f.shadow ? '<rect x="160" y="130" width="710" height="790" fill="#303034"/>' : ''}<polygon points="${f.points}" fill="${f.paper}"/><g clip-path="url(#p)">${text}${f.spread ? '<path d="M500 140 L500 855" stroke="#777" stroke-width="18"/>' : ''}</g></svg>`;
  const {data, info} = await sharp(Buffer.from(svg)).resize(size,size).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const pts = f.points.split(' ').map(p=>p.split(',').map(Number));
  const expected = Object.fromEntries(keys.map((k,i)=>[k,{x:pts[i][0]/1000,y:pts[i][1]/1000}])) as unknown as ScanQuad;
  return {pixels:new Uint8ClampedArray(data),w:info.width,h:info.height,expected};
}
export function cornerError(a: ScanQuad, b: ScanQuad) {
  return keys.reduce((s,k)=>s+Math.hypot(a[k].x-b[k].x,a[k].y-b[k].y),0)/4;
}

async function baseline() {
  const rows = [];
  for (const f of fixtures) {
    const {pixels,w,h,expected} = await fixturePixels(f,420);
    const start = performance.now();
    const quad = detectDocumentSpreadFromField(prepareEdgeFieldFromPixels(pixels,w,h)).fullQuad;
    assert.ok(isSaneQuad(quad), f.name);
    rows.push({scene:f.name,cornerErrorPercent:+(cornerError(quad,expected)*100).toFixed(3),ms:Math.round(performance.now()-start)});
  }
  console.table(rows);
  console.log('Mean baseline corner error:', rows.reduce((s,r)=>s+r.cornerErrorPercent,0)/rows.length, '%');
}
if (process.argv.includes('--baseline')) await baseline();
else {
  const { detectPrecisionDocument, resizeDetectionPixels, extendToFacingPage, straightenSkewedEdges } = await import('../src/lib/precisionDetection');
  const reference = await sharp('scripts/fixtures/partial-facing-page-reference.png').extract({left:284,top:55,width:557,height:600}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const referenceImage = {data:new Uint8ClampedArray(reference.data),width:reference.info.width,height:reference.info.height};
  const referenceExpected: ScanQuad = {tl:{x:.165,y:0},tr:{x:1,y:0},br:{x:1,y:1},bl:{x:.072,y:1}};
  const {automaticDocumentQuad} = await import('../src/lib/automaticDocumentCrop');
  for (const mirrored of [false,true]) for (const angle of [0,90,180,270]) {
    const transform = sharp(reference.data,{raw:{width:reference.info.width,height:reference.info.height,channels:4}});
    if (mirrored) transform.flop();
    const {data,info} = await transform.rotate(angle).raw().toBuffer({resolveWithObject:true});
    let expected = mirrored ? {tl:{x:1-referenceExpected.tr.x,y:referenceExpected.tr.y},tr:{x:1-referenceExpected.tl.x,y:referenceExpected.tl.y},br:{x:1-referenceExpected.bl.x,y:referenceExpected.bl.y},bl:{x:1-referenceExpected.br.x,y:referenceExpected.br.y}} : referenceExpected;
    for(let i=0;i<angle/90;i++) expected={tl:{x:1-expected.bl.y,y:expected.bl.x},tr:{x:1-expected.tl.y,y:expected.tl.x},br:{x:1-expected.tr.y,y:expected.tr.x},bl:{x:1-expected.br.y,y:expected.br.x}};
    const detected=detectPrecisionDocument({data:new Uint8ClampedArray(data),width:info.width,height:info.height});
    assert.equal(detected.source,'partial-leaf-binding',`Reference binding: mirror=${mirrored}, rotation=${angle}`);
    assert.ok(detected.quad&&cornerError(detected.quad,expected)<.025,'Exclude partial leaf without cropping to printed border');
    if (angle === 0 && detected.quad) assert.ok(detected.quad.tl.y < .005 && detected.quad.tr.y < .005 && detected.quad.bl.y > .995 && detected.quad.br.y > .995,'Preserve header and footer paper margins');
    assert.ok(automaticDocumentQuad(detected,'photo'),'Binding outline applies automatically to photos');
    assert.equal(detected.twoPageDetails,null,'Partial leaf is not a complete spread');
  }
  for (const brightness of [1,.7]) {
    const {data,info}=await sharp(reference.data,{raw:{width:reference.info.width,height:reference.info.height,channels:4}}).modulate({brightness}).extend({top:45,bottom:55,left:70,right:60,background:'#35475c'}).raw().toBuffer({resolveWithObject:true});
    const detected=detectPrecisionDocument({data:new Uint8ClampedArray(data),width:info.width,height:info.height});
    const translated=(k: typeof keys[number])=>({x:(referenceExpected[k].x*557+70)/info.width,y:(referenceExpected[k].y*600+45)/info.height});
    const expected: ScanQuad={tl:translated('tl'),tr:translated('tr'),br:translated('br'),bl:translated('bl')};
    assert.ok(detected.quad&&cornerError(detected.quad,expected)<.025,'Exclude partial facing leaf on an uncropped photo');
    assert.ok(automaticDocumentQuad(detected,'photo'),'Apply binding crop before preview enhancement');
  }
  const scaledReference=detectPrecisionDocument(resizeDetectionPixels(referenceImage,420));
  assert.ok(scaledReference.quad&&cornerError(scaledReference.quad,referenceExpected)<.025,'Reference binding at fallback resolution');
  const spreadReference=await sharp('scripts/fixtures/complete-spread-reference.png').extract({left:40,top:72,width:683,height:512}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const spreadImage={data:new Uint8ClampedArray(spreadReference.data),width:683,height:512};
  const spreadExpected: ScanQuad={tl:{x:.04,y:0},tr:{x:.926,y:0},br:{x:.994,y:.93},bl:{x:0,y:.914}};
  for (const mirrored of [false,true]) for (const angle of [0,90,180,270]) {
    const transform=sharp(spreadReference.data,{raw:{width:683,height:512,channels:4}});
    if(mirrored)transform.flop();
    const {data,info}=await transform.rotate(angle).raw().toBuffer({resolveWithObject:true});
    let expected=mirrored?{tl:{x:1-spreadExpected.tr.x,y:spreadExpected.tr.y},tr:{x:1-spreadExpected.tl.x,y:spreadExpected.tl.y},br:{x:1-spreadExpected.bl.x,y:spreadExpected.bl.y},bl:{x:1-spreadExpected.br.x,y:spreadExpected.br.y}}:spreadExpected;
    for(let i=0;i<angle/90;i++)expected={tl:{x:1-expected.bl.y,y:expected.bl.x},tr:{x:1-expected.tl.y,y:expected.tl.x},br:{x:1-expected.tr.y,y:expected.tr.x},bl:{x:1-expected.br.y,y:expected.br.x}};
    const result=detectPrecisionDocument({data:new Uint8ClampedArray(data),width:info.width,height:info.height});
    assert.ok(result.quad&&cornerError(result.quad,expected)<.04,`Keep both reference pages: mirrored=${mirrored}, rotation=${angle}`);
    assert.ok(automaticDocumentQuad(result,'photo'),'Apply complete spread outline automatically');
  }
  const smallSpread=detectPrecisionDocument(resizeDetectionPixels(spreadImage,420));
  assert.ok(smallSpread.quad&&cornerError(smallSpread.quad,spreadExpected)<.04,'Preserve both pages at fallback resolution');
  const notebookReference=await sharp('scripts/fixtures/partial-notebook-reference.png').extract({left:221,top:176,width:384,height:512}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const notebookExpected: ScanQuad={tl:{x:.172,y:.094},tr:{x:.88,y:.11},br:{x:.965,y:.832},bl:{x:.094,y:.846}};
  for(const brightness of [.55,1]) for(const size of [420,720,1800]) for(const angle of [0,90,180,270]) {
    const transform=sharp(notebookReference.data,{raw:{width:384,height:512,channels:4}}).modulate({brightness});
    const {data,info}=await transform.resize({height:size}).rotate(angle).raw().toBuffer({resolveWithObject:true});
    let expected=notebookExpected;
    for(let i=0;i<angle/90;i++)expected={tl:{x:1-expected.bl.y,y:expected.bl.x},tr:{x:1-expected.tl.y,y:expected.tl.x},br:{x:1-expected.tr.y,y:expected.tr.x},bl:{x:1-expected.br.y,y:expected.br.x}};
    const detected=detectPrecisionDocument({data:new Uint8ClampedArray(data),width:info.width,height:info.height});
    assert.ok(detected.quad&&keys.every(k=>Math.hypot(detected.quad![k].x-expected[k].x,detected.quad![k].y-expected[k].y)<.025),`Preserve all notebook corners: brightness=${brightness}, size=${size}, rotation=${angle}`);
  }
  const persistentReference=await sharp('scripts/fixtures/notebook-persistent-reference.png').extract({left:183,top:109,width:384,height:512}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const persistentResult=detectPrecisionDocument({data:new Uint8ClampedArray(persistentReference.data),width:384,height:512});
  assert.ok(persistentResult.quad&&keys.every(k=>Math.hypot(persistentResult.quad![k].x-notebookExpected[k].x,persistentResult.quad![k].y-notebookExpected[k].y)<.025),'Latest notebook reference preserves top corners');
  const notebookOriginal=await sharp('scripts/fixtures/original-notebook.jpg').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const originalResult=detectPrecisionDocument({data:new Uint8ClampedArray(notebookOriginal.data),width:notebookOriginal.info.width,height:notebookOriginal.info.height});
  const originalExpected: ScanQuad={tl:{x:.162,y:.096},tr:{x:.878,y:.111},br:{x:.967,y:.832},bl:{x:.087,y:.843}};
  console.log('[v0] Original notebook',originalResult.source,JSON.stringify(originalResult.quad));
  assert.ok(originalResult.quad&&keys.every(k=>Math.hypot(originalResult.quad![k].x-originalExpected[k].x,originalResult.quad![k].y-originalExpected[k].y)<.025),'Original notebook keeps outer page corners');
  const pageQuad: ScanQuad = {tl:{x:.1,y:.15},tr:{x:.5,y:.15},br:{x:.5,y:.85},bl:{x:.1,y:.85}};
  for (const [name, rightEdge, shouldExtend] of [
    ['complete facing page', 900, true],
    ['half facing page', 700, false],
    ['mostly visible clipped facing page', 1100, false],
    ['single page', 500, false],
  ] as const) {
    const svg = `<svg width="1000" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1000" fill="#444"/><rect x="100" y="150" width="${rightEdge-100}" height="700" fill="#eee"/><path d="M500 150 V850" stroke="#666" stroke-width="12"/></svg>`;
    const {data,info} = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const image = {data:new Uint8ClampedArray(data),width:info.width,height:info.height};
    const extended = extendToFacingPage(image,pageQuad);
    assert.equal(!!extended, shouldExtend, name);
    const detected = detectPrecisionDocument(image);
    const expected = shouldExtend ? {...pageQuad,tr:{x:.9,y:.15},br:{x:.9,y:.85}} : pageQuad;
    assert.ok(detected.quad && cornerError(detected.quad,expected)<.015, `${name}: detected crop ${JSON.stringify(detected.quad)}`);
    if (extended) assert.ok(Math.abs(extended.tr.x-.9)<.015, `${name}: outer boundary`);
    const rotated = await sharp(Buffer.from(data),{raw:{width:info.width,height:info.height,channels:4}}).rotate(90).raw().toBuffer({resolveWithObject:true});
    const rotatedQuad: ScanQuad = {tl:{x:1-pageQuad.bl.y,y:pageQuad.bl.x},tr:{x:1-pageQuad.tl.y,y:pageQuad.tl.x},br:{x:1-pageQuad.tr.y,y:pageQuad.tr.x},bl:{x:1-pageQuad.br.y,y:pageQuad.br.x}};
    const rotatedImage = {data:new Uint8ClampedArray(rotated.data),width:rotated.info.width,height:rotated.info.height};
    assert.equal(!!extendToFacingPage(rotatedImage,rotatedQuad),shouldExtend,`${name}: rotated`);
    const rotatedExpected: ScanQuad = {tl:{x:1-expected.bl.y,y:expected.bl.x},tr:{x:1-expected.tl.y,y:expected.tl.x},br:{x:1-expected.tr.y,y:expected.tr.x},bl:{x:1-expected.br.y,y:expected.br.x}};
    const rotatedDetection = detectPrecisionDocument(rotatedImage);
    assert.ok(rotatedDetection.quad&&cornerError(rotatedDetection.quad,rotatedExpected)<.015,`${name}: rotated detected crop`);
  }
  {
    const svg=`<svg width="1000" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1000" fill="#222"/><rect x="150" y="150" width="700" height="700" fill="#eee"/></svg>`;
    const {data,info}=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const skewed: ScanQuad={tl:{x:.15,y:.08},tr:{x:.85,y:.4},br:{x:.85,y:.85},bl:{x:.15,y:.85}};
    const repaired=straightenSkewedEdges({data:new Uint8ClampedArray(data),width:info.width,height:info.height},skewed);
    const target: ScanQuad={tl:{x:.15,y:.15},tr:{x:.85,y:.15},br:{x:.85,y:.85},bl:{x:.15,y:.85}};
    assert.ok(cornerError(repaired,target)<.02,`Skewed top edge is straightened: ${JSON.stringify(repaired)}`);
  }
  const rows=[];
  let baselineTotal=0,improvedTotal=0,compared=0;
  const inside=(q:ScanQuad,x:number,y:number)=>keys.every((k,i)=>{
    const a=q[k],b=q[keys[(i+1)%4]];
    return (b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x)>=0;
  });
  const overlap=(q:ScanQuad,expected:ScanQuad)=>{
    let intersection=0,union=0,clipped=0,truth=0,background=0;
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){
      const a=inside(q,(x+.5)/512,(y+.5)/512),b=inside(expected,(x+.5)/512,(y+.5)/512);
      if(a&&b)intersection++;if(a||b)union++;if(b)truth++;if(b&&!a)clipped++;if(a&&!b)background++;
    }
    return {iou:intersection/union,clipping:clipped/truth,background:background/truth};
  };
  for(const f of fixtures) {
    const {pixels,w,h,expected}=await fixturePixels(f);
    const input={data:pixels,width:w,height:h};
    const low=resizeDetectionPixels(input,420);
    const before=detectDocumentSpreadFromField(prepareEdgeFieldFromPixels(low.data,low.width,low.height)).fullQuad;
    const oldError=cornerError(before,expected),oldOverlap=overlap(before,expected);
    const result=detectPrecisionDocument(input);
    if(result.quad){
      assert.ok(isSaneQuad(result.quad),f.name);
      for(const k of keys){assert.ok(result.quad[k].x>=0&&result.quad[k].x<=1);assert.ok(result.quad[k].y>=0&&result.quad[k].y<=1);}
      const error=cornerError(result.quad,expected),metrics=overlap(result.quad,expected);
      assert.ok(error<.015,`${f.name}: corner error ${error}`);
      assert.ok(error<=oldError+.0015,`${f.name}: corner error regression`);
      assert.ok(metrics.clipping<=oldOverlap.clipping+.005,`${f.name}: inward clipping regression`);
      baselineTotal+=oldError;improvedTotal+=error;compared++;
      rows.push({scene:f.name,quality:result.quality,beforePercent:+(oldError*100).toFixed(3),afterPercent:+(error*100).toFixed(3),iou:+metrics.iou.toFixed(4),clippingPercent:+(metrics.clipping*100).toFixed(3),ms:Math.round(result.durationMs)});
    }else{
      assert.equal(result.quality,'none');
      assert.equal(f.name,'frame touching','Unexpected abstention on a visible boundary');
      rows.push({scene:f.name,quality:'none (keep whole image)',beforePercent:+(oldError*100).toFixed(3),afterPercent:null,iou:null,clippingPercent:0,ms:Math.round(result.durationMs)});
    }
  }
  assert.ok(improvedTotal<baselineTotal*.5,'No meaningful overall precision improvement');
  console.table(rows);
  console.log(`Comparable ${compared}/12 scenes: mean corner error ${(baselineTotal/compared*100).toFixed(3)}% → ${(improvedTotal/compared*100).toFixed(3)}%. Uncertain detections retain the whole image.`);
  for(const scene of ['blank','faint','gradient','noise','stripes']){
    const w=420,h=420,data=new Uint8ClampedArray(w*h*4);let seed=941;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const value=scene==='blank'?210:scene==='faint'?(x>80&&x<350&&y>60&&y<360?205:200):scene==='gradient'?100+x/4+y/5:scene==='stripes'?90+(x%30<15?35:0):80+(seed%120);
      const i=(y*w+x)*4;data[i]=value;data[i+1]=value;data[i+2]=value;data[i+3]=255;
    }
    const result=detectPrecisionDocument({data,width:w,height:h});
    assert.notEqual(result.quality,'strong',`${scene}: unjustified confident auto-crop`);
    if(scene==='blank'||scene==='faint')assert.equal(result.quad,null,scene);
  }
  const f=await fixturePixels(fixtures[1]);
  const original=detectPrecisionDocument({data:f.pixels,width:f.w,height:f.h});
  assert.ok(original.quad);
  const scaled=detectPrecisionDocument(resizeDetectionPixels({data:f.pixels,width:f.w,height:f.h},900));
  assert.ok(scaled.quad&&cornerError(original.quad,scaled.quad)<.006,'Scale equivalence');
  const again=detectPrecisionDocument({data:f.pixels,width:f.w,height:f.h});
  assert.deepEqual(again.quad,original.quad,'Deterministic repeatability');
  for(const angle of [90,180,270]){
    const rotated=await sharp(Buffer.from(f.pixels),{raw:{width:f.w,height:f.h,channels:4}}).rotate(angle).raw().toBuffer({resolveWithObject:true});
    let expected=original.quad;
    for(let i=0;i<angle/90;i++)expected={tl:{x:1-expected.bl.y,y:expected.bl.x},tr:{x:1-expected.tl.y,y:expected.tl.x},br:{x:1-expected.tr.y,y:expected.tr.x},bl:{x:1-expected.br.y,y:expected.br.x}};
    const result=detectPrecisionDocument({data:new Uint8ClampedArray(rotated.data),width:rotated.info.width,height:rotated.info.height});
    assert.ok(result.quad&&cornerError(result.quad,expected)<.007,`Rotation equivalence ${angle}`);
  }
  const transport=await import('../src/lib/documentDetectionClient');
  const descriptors=new Map(['Image','Worker','OffscreenCanvas','createImageBitmap','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const fixture=await fixturePixels(fixtures[0],128);
  let fail=false,hold=false,active=0,maxActive=0,terminations=0;
  class TestImage {
    naturalWidth=128;naturalHeight=128;width=128;height=128;
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
    set src(url:string){if(url)queueMicrotask(()=>this.onload?.());}
  }
  class TestWorker {
    onmessage:((e:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;onmessageerror:(()=>void)|null=null;
    timer:ReturnType<typeof setTimeout>|null=null;
    postMessage(job:{id:number;bitmap:{close:()=>void}}){
      active++;maxActive=Math.max(maxActive,active);
      if(fail){queueMicrotask(()=>this.onerror?.());return;}
      if(hold)return;
      this.timer=setTimeout(()=>{active--;this.timer=null;job.bitmap.close();this.onmessage?.({data:{id:job.id,result:{...original,width:128,height:128}}});},3);
    }
    terminate(){terminations++;if(this.timer)clearTimeout(this.timer);active=0;}
  }
  const context={fillStyle:'',imageSmoothingQuality:'',fillRect(){},translate(){},rotate(){},drawImage(){},getImageData(){return {data:fixture.pixels};}};
  const mocks={Image:TestImage,Worker:TestWorker,OffscreenCanvas:class {},createImageBitmap:async()=>({width:128,height:128,close(){}}),document:{createElement:()=>({width:0,height:0,getContext:()=>context})}};
  for(const [key,value]of Object.entries(mocks))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  try{
    const a=transport.detectDocumentCached('dedupe',0),b=transport.detectDocumentCached('dedupe',0);
    assert.equal(a,b,'Concurrent callers share a job');await a;
    const requests=Array.from({length:10},(_,i)=>transport.detectDocumentCached(`cache-${i}`,0));
    await Promise.all(requests);assert.equal(maxActive,1,'Heavy jobs serialize');assert.equal(transport.detectionCacheSize(),8,'Cache is bounded');
    transport.releaseDocumentDetection('cache-9');assert.equal(transport.detectionCacheSize(),7,'Source invalidation');
    transport.clearDocumentDetections();assert.equal(transport.detectionCacheSize(),0);
    fail=true;const fallback=await transport.detectDocumentCached('worker-error',0);
    assert.notEqual(fallback.quality,'strong','Fallback cannot silently auto-crop');assert.match(fallback.reason,/resolution|No reliable/);
    fail=false;const recovered=await transport.detectDocumentCached('worker-recovered',0);assert.ok(recovered.quad,'Worker can restart');
    hold=true;const stale=transport.detectDocumentCached('cancelled-job',0);
    const rejected=assert.rejects(stale,/Stale detection/);
    await new Promise(resolve=>setTimeout(resolve,10));transport.clearDocumentDetections();await rejected;
    assert.ok(terminations>=2,'Workers are released');
    const snap=transport.createBoundarySnapEngine(original),quad=original.quad!;
    const point=snap.snapPoint({x:quad.tl.x+.002,y:quad.tl.y+.002},'tl',600,600);
    assert.ok(point.snapped&&point.type==='corner','Verified corners snap locally');
    const empty=transport.createBoundarySnapEngine({...original,quality:'none',quad:null,edgeSupport:[0,0,0,0]});
    assert.equal(empty.snapPoint({x:.5,y:.5},'tl',600,600).snapped,false,'No arbitrary print-ridge snapping');
  }finally{
    transport.clearDocumentDetections();
    for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
  console.log('PASS: geometry, overlap, inward clipping, abstention, scale, rotations, repeatability, job serialization, cache bounds/invalidation, worker failure/restart, stale cancellation and local snaps. Includes the supplied notebook screenshot at all four rotations, mirrored, and reduced resolution; broader real-photo accuracy remains unmeasured.');
}
