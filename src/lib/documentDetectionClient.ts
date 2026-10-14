import { loadImageFromUrl } from './scannerFilters';
import { detectPrecisionDocument, type DocumentDetectionResult, type DetectionPixels } from './precisionDetection';
import type { EdgeSnapEngine, Point, QuadCorner } from './edgeDetector';
import { createLocalSnapEngine } from './localEdgeSnapping';

type Rotation=0|90|180|270;
let worker:Worker|null=null, jobId=0,epoch=0;
let queue:Promise<unknown>=Promise.resolve();
const cache=new Map<string,{source:string;promise:Promise<DocumentDetectionResult>}>();
const pending=new Map<number,{resolve:(r:DocumentDetectionResult)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const keyFor=(url:string,rotation:Rotation)=>`${rotation}:${url}`;
function stopWorker(){
  worker?.terminate();worker=null;
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Detection worker stopped'));}
  pending.clear();
}
function getWorker(){
  if(worker)return worker;
  worker=new Worker(new URL('./documentDetection.worker.ts',import.meta.url),{type:'module'});
  worker.onmessage=({data})=>{
    const p=pending.get(data.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(data.id);
    if(data.error)p.reject(new Error(data.error));else p.resolve(data.result);
  };
  worker.onerror=()=>stopWorker();
  worker.onmessageerror=()=>stopWorker();
  return worker;
}
function preparePixels(image:HTMLImageElement,rotation:Rotation,maxEdge:number):DetectionPixels {
  const turned=rotation===90||rotation===270,w0=turned?image.naturalHeight:image.naturalWidth,h0=turned?image.naturalWidth:image.naturalHeight;
  const scale=Math.min(1,maxEdge/Math.max(w0,h0)),width=Math.max(16,Math.round(w0*scale)),height=Math.max(16,Math.round(h0*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('Canvas unavailable');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.imageSmoothingQuality='high';ctx.translate(width/2,height/2);ctx.rotate(rotation*Math.PI/180);
  const dw=turned?height:width,dh=turned?width:height;ctx.drawImage(image,-dw/2,-dh/2,dw,dh);
  return {data:ctx.getImageData(0,0,width,height).data,width,height};
}
async function run(url:string,rotation:Rotation,version:number){
  if(version!==epoch)throw new Error('Stale detection');
  const image=await loadImageFromUrl(url);
  if(version!==epoch)throw new Error('Stale detection');
  try{
    if(typeof Worker==='undefined')throw new Error('Workers unavailable');
    const w=getWorker(),id=++jobId;
    let bitmap:ImageBitmap|undefined,pixels:DetectionPixels|undefined;
    if(typeof OffscreenCanvas!=='undefined'&&typeof createImageBitmap==='function')bitmap=await createImageBitmap(image);
    else pixels=preparePixels(image,rotation,1800);
    if(version!==epoch){bitmap?.close();throw new Error('Stale detection');}
    const result = await new Promise<DocumentDetectionResult>((resolve,reject)=>{
      const timer=setTimeout(()=>stopWorker(),30000);pending.set(id,{resolve,reject,timer});
      try{w.postMessage({id,bitmap,pixels,rotation},bitmap?[bitmap]:[pixels!.data.buffer]);}
      catch(error){clearTimeout(timer);pending.delete(id);bitmap?.close();reject(error instanceof Error?error:new Error('Transfer failed'));}
    });
    const turned=rotation===90||rotation===270;
    return {...result,width:turned?image.naturalHeight:image.naturalWidth,height:turned?image.naturalWidth:image.naturalHeight};
  }catch{
    if(version!==epoch)throw new Error('Stale detection');
    // Failure recovery is deliberately bounded; never run the full high-res job on the UI thread.
    await new Promise(resolve=>setTimeout(resolve,0));
    const result=detectPrecisionDocument(preparePixels(image,rotation,420));
    const turned=rotation===90||rotation===270;
    return {...result,width:turned?image.naturalHeight:image.naturalWidth,height:turned?image.naturalWidth:image.naturalHeight,quality:result.quad?'review' as const:'none' as const,reason:result.quad?'Reduced-resolution detection — check edges':'No reliable page boundary found'};
  }
}
export function detectDocumentCached(url:string,rotation:Rotation):Promise<DocumentDetectionResult>{
  const key=keyFor(url,rotation),hit=cache.get(key);
  if(hit){cache.delete(key);cache.set(key,hit);return hit.promise;}
  const version=epoch;
  const promise=queue.then(()=>run(url,rotation,version));
  queue=promise.catch(()=>{});
  cache.set(key,{source:url,promise});
  while(cache.size>8)cache.delete(cache.keys().next().value!);
  void promise.catch(()=>{if(cache.get(key)?.promise===promise)cache.delete(key);});
  return promise;
}
/** Spawns the worker ahead of the first upload so its module load is off the critical path. */
export function warmDocumentDetection(){try{if(typeof Worker!=='undefined')getWorker();}catch{/* detection falls back on demand */}}
export function releaseDocumentDetection(url:string){for(const [key,value]of cache)if(value.source===url)cache.delete(key);}
export function clearDocumentDetections(){epoch++;cache.clear();stopWorker();queue=Promise.resolve();}
export function detectionCacheSize(){return cache.size;}

export type DetectionSnapEngine=EdgeSnapEngine&{detection:DocumentDetectionResult};
export function createBoundarySnapEngine(detection:DocumentDetectionResult):DetectionSnapEngine {
  const q=detection.quad,keys=['tl','tr','br','bl'] as const;
  const local=detection.localEdges?createLocalSnapEngine(detection.localEdges):null;
  const lines=q?keys.map((k,i)=>({a:q[k],b:q[keys[(i+1)%4]],support:detection.edgeSupport[i]})).filter(l=>l.support>=.65):[];
  const project=(p:Point,a:Point,b:Point,w:number,h:number)=>{
    const dx=(b.x-a.x)*w,dy=(b.y-a.y)*h,l2=dx*dx+dy*dy;
    if(l2<1)return null;
    const t=((p.x-a.x)*w*dx+(p.y-a.y)*h*dy)/l2;
    const point={x:Math.max(0,Math.min(1,a.x+t*(b.x-a.x))),y:Math.max(0,Math.min(1,a.y+t*(b.y-a.y)))};
    return {point,distance:Math.hypot((point.x-p.x)*w,(point.y-p.y)*h),t};
  };
  return {detection,autoQuad:q,twoPageSpread:detection.twoPageDetails,
    snapPoint(p:Point,corner:QuadCorner,w:number,h:number,radius=22){
      if(q&&detection.quality==='strong'){
        const i=keys.indexOf(corner);
        if(detection.edgeSupport[i]>=.65&&detection.edgeSupport[(i+3)%4]>=.65){const target=q[corner];if(Math.hypot((p.x-target.x)*w,(p.y-target.y)*h)<=radius)return {...target,snapped:true,type:'corner'};}
      }
      let best:ReturnType<typeof project>=null;
      for(const line of lines){const v=project(p,line.a,line.b,w,h);if(v&&v.t>=-.05&&v.t<=1.05&&v.distance<=radius&&(!best||v.distance<best.distance))best=v;}
      return best?{...best.point,snapped:true,type:'edge'}:local?.snapPoint(p,corner,w,h,radius)??{...p,snapped:false};
    },
    snapEdge(a:Point,b:Point,w:number,h:number,radius=22){
      let best:{a:Point;b:Point;distance:number}|null=null;
      const dx=(b.x-a.x)*w,dy=(b.y-a.y)*h,len=Math.hypot(dx,dy);
      for(const line of lines){
        const lx=(line.b.x-line.a.x)*w,ly=(line.b.y-line.a.y)*h;
        if(Math.abs(dx*lx+dy*ly)/Math.max(1,len*Math.hypot(lx,ly))<.98)continue;
        const pa=project(a,line.a,line.b,w,h),pb=project(b,line.a,line.b,w,h);
        if(!pa||!pb)continue;const distance=Math.max(pa.distance,pb.distance);
        if(distance<=radius&&(!best||distance<best.distance))best={a:pa.point,b:pb.point,distance};
      }
      return best?{a:best.a,b:best.b,snapped:true,type:'line'}:local?.snapEdge(a,b,w,h,radius)??{a,b,snapped:false};
    },
  };
}
