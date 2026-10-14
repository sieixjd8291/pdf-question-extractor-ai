import { detectPrecisionDocument, type DetectionPixels } from './precisionDetection';

type Job = { id: number; bitmap?: ImageBitmap; pixels?: DetectionPixels; rotation: 0 | 90 | 180 | 270 };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Job>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = ({data:job}) => {
  try {
    let pixels=job.pixels;
    let width=pixels?.width??0,height=pixels?.height??0;
    if(job.bitmap){
      const bitmap=job.bitmap,turned=job.rotation===90||job.rotation===270;
      width=turned?bitmap.height:bitmap.width;height=turned?bitmap.width:bitmap.height;
      const scale=Math.min(1,1800/Math.max(width,height));
      const w=Math.max(16,Math.round(width*scale)),h=Math.max(16,Math.round(height*scale));
      const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(!ctx)throw new Error('Worker canvas unavailable');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.imageSmoothingQuality='high';
      ctx.translate(w/2,h/2);ctx.rotate(job.rotation*Math.PI/180);
      const dw=turned?h:w,dh=turned?w:h;ctx.drawImage(bitmap,-dw/2,-dh/2,dw,dh);
      pixels={data:ctx.getImageData(0,0,w,h).data,width:w,height:h};
    }
    if(!pixels)throw new Error('Missing image data');
    const result=detectPrecisionDocument(pixels);
    scope.postMessage({id:job.id,result:{...result,width,height}},result.localEdges?[result.localEdges.horizontal.buffer as ArrayBuffer,result.localEdges.vertical.buffer as ArrayBuffer]:[]);
  }catch(error){scope.postMessage({id:job.id,error:error instanceof Error?error.message:'Detection failed'});}
  finally{job.bitmap?.close();}
};
