import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectPrecisionDocument } from '../src/lib/precisionDetection';
import { createBoundarySnapEngine } from '../src/lib/documentDetectionClient';
import { automaticDocumentQuad } from '../src/lib/automaticDocumentCrop';

const {data,info}=await sharp(new URL('./fixtures/notebook-crop-screenshot.png',import.meta.url).pathname).extract({left:405,top:53,width:845,height:630}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const result=detectPrecisionDocument({data:new Uint8ClampedArray(data),width:info.width,height:info.height});
console.log('Notebook detection', {quad:result.quad,quality:result.quality,source:result.source,support:result.edgeSupport});
const engine=createBoundarySnapEngine({...result,quad:null,quality:'none',edgeSupport:[0,0,0,0]});
console.log('Left page local snap',engine.snapPoint({x:.076,y:.5},'tl',845,630));
console.log('Bottom page local snap',engine.snapEdge({x:.08,y:.964},{x:.48,y:.985},845,630));
if(process.argv.includes('--assert')){
  assert.ok(result.quad,'Notebook should offer a reviewable boundary');
  assert.deepEqual(automaticDocumentQuad(result,'photo'),result.quad,'Notebook photo applies immediately after upload');
  assert.deepEqual(automaticDocumentQuad(result,'pdf'),result.quad,'Notebook scan inside PDF applies immediately after upload');
  assert.deepEqual(automaticDocumentQuad({...result,quality:'review',source:'canny',edgeSupport:[.6,.7,.8,.8]},'photo'),result.quad,'Reasonable review outlines of photos still crop on upload');
  assert.deepEqual(automaticDocumentQuad({...result,reason:'Reduced-resolution detection — check edges'},'photo'),result.quad,'Reduced-resolution fallback still crops photos');
  assert.equal(automaticDocumentQuad({...result,quality:'review',edgeSupport:[.3,.4,.5,.45]},'photo'),null,'Very weak outlines stay uncut');
  assert.equal(automaticDocumentQuad({...result,quality:'none'},'photo'),null,'No detection stays uncut');
  assert.equal(automaticDocumentQuad({...result,source:'canny',quality:'strong'},'pdf'),null,'Digital PDF printed borders are not automatic crops');
  assert.equal(automaticDocumentQuad({...result,reason:'Reduced-resolution detection — check edges'},'pdf'),null,'Reduced-resolution fallback needs review for PDFs');
  assert.equal(automaticDocumentQuad({...result,quad:{tl:{x:0,y:0},tr:{x:1,y:0},br:{x:1,y:1},bl:{x:0,y:1}}},'pdf'),null,'Full-page PDFs preserve existing page boundaries');
  assert.ok(result.quad.tl.x>.025&&result.quad.tl.x<.14,'Outer notebook, not printed table');
  assert.ok(engine.snapPoint({x:.076,y:.5},'tl',845,630).snapped,'Local snap without global quad');
  const edge=engine.snapEdge({x:.08,y:.964},{x:.48,y:.985},845,630);
  assert.ok(edge.snapped,'Local edge snap without global quad');
  assert.ok(result.quad.tr.x>.95&&result.quad.br.x>.95&&result.quad.bl.y>.94,'Keep both pages, not the printed table');
  const corner=engine.snapPoint({x:.076,y:.5},'tl',845,630);
  assert.ok(Math.abs(corner.x-.066)<.01,'Snap onto the photographed page edge');
  assert.ok(Math.hypot((corner.x-.076)*845,(corner.y-.5)*630)<=22,'Corner stays within screen-space snap radius');
  assert.ok(engine.snapPoint({x:.076,y:.5},'tl',422.5,315).snapped,'Responsive preview coordinates');
  assert.equal(engine.snapPoint({x:.076,y:.5},'tl',845,630,0).snapped,false,'Zero radius does not snap');
  const {prepareLocalEdges,createLocalSnapEngine}=await import('../src/lib/localEdgeSnapping');
  for(const [width,height] of [[37,29],[19,43],[8,8]]){
    const pixels=new Uint8ClampedArray(width*height*4);
    let seed=941;
    for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[i]=seed>>>24;}
    const actual=prepareLocalEdges(pixels,width,height);
    const horizontal=new Float32Array(width*height),vertical=new Float32Array(width*height);
    const reference=(x:number,y:number,dx:number,dy:number)=>{
      let sharp=0,broad=0,polarity=0;
      const at=(offset:number,c:number)=>pixels[((y+dy*offset)*width+x+dx*offset)*4+c];
      for(let c=0;c<3;c++){
        const g=at(2,c)-at(-2,c),d=(at(6,c)+at(4,c)-at(-6,c)-at(-4,c))/2;
        sharp+=g*g;broad+=d*d;polarity+=g*d;
      }
      return polarity>0?Math.min(Math.sqrt(sharp/3),Math.sqrt(broad/3)*1.25):0;
    };
    for(let y=6;y<height-6;y++)for(let x=6;x<width-6;x++){
      const i=y*width+x;horizontal[i]=reference(x,y,0,1);vertical[i]=reference(x,y,1,0);
    }
    assert.deepEqual(actual.horizontal,horizontal,'Optimized horizontal responses match the reference exactly');
    assert.deepEqual(actual.vertical,vertical,'Optimized vertical responses match the reference exactly');
  }
  for(const angle of [90,180,270]){
    const rotated=await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).rotate(angle).raw().toBuffer({resolveWithObject:true});
    const local=createLocalSnapEngine(prepareLocalEdges(new Uint8ClampedArray(rotated.data),rotated.info.width,rotated.info.height));
    let p={x:.076,y:.5};for(let i=0;i<angle/90;i++)p={x:1-p.y,y:p.x};
    assert.ok(local.snapPoint(p,'tl',rotated.info.width,rotated.info.height).snapped,`Rotated local snap ${angle}`);
  }
  for(const text of ['', '<path d="M130 180 H370 M130 220 H370" stroke="#222" stroke-width="2"/>']){
    const fixture=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400"><rect width="500" height="400" fill="#ddddda"/><rect x="80" y="50" width="340" height="310" fill="#eeeeeb"/>${text}</svg>`)).ensureAlpha().raw().toBuffer();
    const local=createLocalSnapEngine(prepareLocalEdges(new Uint8ClampedArray(fixture),500,400));
    assert.ok(local.snapPoint({x:.174,y:.3},'tl',500,400).snapped,'Basic low-contrast local page boundary');
    assert.ok(local.snapEdge({x:.19,y:.139},{x:.81,y:.139},500,400).snapped,'Basic local top edge');
    assert.equal(local.snapPoint({x:.5,y:.5},'tl',500,400).snapped,false,'Blank interior / thin print strokes do not snap');
  }
  console.log('PASS: notebook outer boundary, no-quad corner and edge snapping, radius bounds, responsive coordinates, rotations, low contrast, blank interiors and thin-print rejection. Notebook fixture is extracted from the supplied screenshot, not the original capture.');
}
