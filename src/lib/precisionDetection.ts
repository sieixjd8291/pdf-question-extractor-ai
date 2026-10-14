import {
  detectDocumentSpreadFromField, prepareEdgeFieldFromPixels, findMaskComponentHulls,
  fitQuadToContourByLines, orderQuadCorners, isSaneQuad, polygonArea, scoreQuadCandidate,
  type Point, type TwoPageDetails, type OrientedEdgeField,
} from './edgeDetector';
import type { ScanQuad } from './scannerFilters';

import { prepareLocalEdges, type LocalEdgeField } from './localEdgeSnapping';

export type DetectionQuality = 'strong' | 'review' | 'none';
export interface DocumentDetectionResult {
  quad: ScanQuad | null;
  quality: DetectionQuality;
  edgeSupport: number[];
  source: string;
  reason: string;
  twoPageDetails: TwoPageDetails | null;
  width: number;
  height: number;
  durationMs: number;
  localEdges?: LocalEdgeField;
}
export interface DetectionPixels { data: Uint8ClampedArray; width: number; height: number }
const keys = ['tl', 'tr', 'br', 'bl'] as const;
type QuadPoints = [Point, Point, Point, Point];
const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const median = (values: number[]) => { const sorted = values.slice().sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)] ?? 0; };
const normalize = (pts: QuadPoints, w: number, h: number): ScanQuad => Object.fromEntries(keys.map((k,i)=>[k,{x:clamp(pts[i].x/w),y:clamp(pts[i].y/h)}])) as unknown as ScanQuad;
const points = (q: ScanQuad, w: number, h: number): QuadPoints => keys.map(k=>({x:q[k].x*w,y:q[k].y*h})) as QuadPoints;

export function resizeDetectionPixels(input: DetectionPixels, maxEdge: number): DetectionPixels {
  const scale = Math.min(1,maxEdge/Math.max(input.width,input.height));
  if (scale === 1) return input;
  const width = Math.max(2,Math.round(input.width*scale)), height = Math.max(2,Math.round(input.height*scale));
  const data = new Uint8ClampedArray(width*height*4), src=input.data, iw=input.width;
  const xs0=new Int32Array(width), xs1=new Int32Array(width);
  for(let x=0;x<width;x++){xs0[x]=Math.floor(x*iw/width);xs1[x]=Math.max(xs0[x]+1,Math.floor((x+1)*iw/width));}
  const rowSum=new Float64Array(iw*3);
  // Area sampling avoids decimating thin boundaries when reducing large captures.
  for (let y=0;y<height;y++) {
    const y0=Math.floor(y*input.height/height), y1=Math.max(y0+1,Math.floor((y+1)*input.height/height)), rows=y1-y0;
    rowSum.fill(0);
    for(let yy=y0;yy<y1;yy++){let i=yy*iw*4;for(let xx=0,k=0;xx<iw;xx++,i+=4,k+=3){rowSum[k]+=src[i];rowSum[k+1]+=src[i+1];rowSum[k+2]+=src[i+2];}}
    for(let x=0;x<width;x++){
      let r=0,g=0,b=0;
      for(let xx=xs0[x],k=xx*3;xx<xs1[x];xx++,k+=3){r+=rowSum[k];g+=rowSum[k+1];b+=rowSum[k+2];}
      const n=rows*(xs1[x]-xs0[x]),i=(y*width+x)*4; data[i]=r/n; data[i+1]=g/n; data[i+2]=b/n; data[i+3]=255;
    }
  }
  return {data,width,height};
}

function cannyCandidates(f: OrientedEdgeField): QuadPoints[] {
  const {w,h,colorGrad,gradX,gradY} = f;
  const n=w*h, suppressed=new Float32Array(n), histogram=new Uint32Array(1024);
  let nonzero=0;
  for(let y=2;y<h-2;y++) for(let x=2;x<w-2;x++) {
    const i=y*w+x, angle=(Math.atan2(gradY[i],gradX[i])*180/Math.PI+180)%180;
    const d=angle<22.5||angle>=157.5?1:angle<67.5?w+1:angle<112.5?w:w-1;
    const v=colorGrad[i];
    if(v>=colorGrad[i-d]&&v>=colorGrad[i+d]&&v>4){suppressed[i]=v;histogram[Math.min(1023,Math.round(v))]++;nonzero++;}
  }
  let high=12, count=0;
  for(let i=0;i<1024;i++){count+=histogram[i];if(count>=nonzero*.8){high=Math.max(12,i);break;}}
  const low=high*.35, mask=new Uint8Array(n), queue=new Int32Array(n);let head=0,tail=0;
  for(let i=0;i<n;i++)if(suppressed[i]>=high){mask[i]=1;queue[tail++]=i;}
  while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const xx=x+dx,yy=y+dy,j=yy*w+xx;if(xx<1||xx>=w-1||yy<1||yy>=h-1||mask[j]||suppressed[j]<low)continue;mask[j]=1;queue[tail++]=j;
  }}
  // A one-pixel dilation bridges broken antialiased boundaries, not page gutters.
  const closed=new Uint8Array(n);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;if(mask[i])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)closed[i+dy*w+dx]=1;}
  return findMaskComponentHulls(closed,w,h,Math.min(w,h)*.45,n*.35)
    .filter(hull=>polygonArea(hull)>n*.025)
    .map(hull=>hull.length===4?orderQuadCorners(hull):fitQuadToContourByLines(hull)).filter((q):q is QuadPoints=>!!q);
}

function colorCandidates(image: DetectionPixels): QuadPoints[] {
  const {width:w,height:h,data}=image;
  const channels=[[],[],[]] as number[][];
  for(let x=0;x<w;x+=3)for(const y of [0,h-1])for(let c=0;c<3;c++)channels[c].push(data[(y*w+x)*4+c]);
  for(let y=0;y<h;y+=3)for(const x of [0,w-1])for(let c=0;c<3;c++)channels[c].push(data[(y*w+x)*4+c]);
  const bg=channels.map(median), dev=channels.map((a,c)=>median(a.map(v=>Math.abs(v-bg[c]))));
  const threshold=Math.max(10,Math.hypot(...dev)*2.5), mask=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){const j=i*4;if(Math.hypot(data[j]-bg[0],data[j+1]-bg[1],data[j+2]-bg[2])>threshold)mask[i]=1;}
  return findMaskComponentHulls(mask,w,h,w*h*.02,w*h*.999)
    .map(hull=>hull.length===4?orderQuadCorners(hull):fitQuadToContourByLines(hull)).filter((q):q is QuadPoints=>!!q);
}

function paperExposure(image: DetectionPixels): number {
  const neutral: number[] = [];
  for (let i = 0; i < image.data.length; i += 64) {
    const lo = Math.min(image.data[i], image.data[i + 1], image.data[i + 2]);
    const hi = Math.max(image.data[i], image.data[i + 1], image.data[i + 2]);
    if (hi - lo < 35) neutral.push(lo);
  }
  if (neutral.length < 32) return 1;
  neutral.sort((a, b) => a - b);
  return clamp(neutral[Math.floor(neutral.length * .9)] / 235, .45, 1);
}

function paperCandidates(image: DetectionPixels): QuadPoints[] {
  const {width:w,height:h,data}=image;
  const exposure=paperExposure(image);
  const result:QuadPoints[]=[];
  for(const threshold of [170,195,215]){
    const mask=new Uint8Array(w*h);
    for(let i=0;i<w*h;i++){
      const j=i*4,lo=Math.min(data[j],data[j+1],data[j+2]),hi=Math.max(data[j],data[j+1],data[j+2]);
      if(lo>=threshold*exposure&&hi-lo<35*exposure)mask[i]=1;
    }
    const spans=(fixed:number,horizontal:boolean)=>{
      const length=horizontal?w:h,values=new Uint8Array(length);
      for(let p=5;p<length-5;p++){
        let count=0;for(let d=-4;d<=4;d++)count+=mask[horizontal?fixed*w+p+d:(p+d)*w+fixed];
        values[p]=Number(count>=5);
      }
      const runs:Array<[number,number]>=[];let start=-1,gap=0;
      for(let p=0;p<=length+8;p++){
        if(values[p]){if(start<0)start=p;gap=0;}
        else if(start>=0&&++gap>8){if(p-gap-start>length*.18)runs.push([start,p-gap]);start=-1;}
      }
      if(!runs.length)return null;
      const first=runs[0][0],last=runs[runs.length-1][1];
      return [first<=6&&mask[horizontal?fixed*w:fixed]?0:first,last>=length-7&&mask[horizontal?fixed*w+length-1:(length-1)*w+fixed]?length:last];
    };
    const left:Point[]=[],right:Point[]=[],top:Point[]=[],bottom:Point[]=[];
    for(let y=Math.round(h*.16);y<h*.86;y+=4){const s=spans(y,true);if(s){left.push({x:s[0],y});right.push({x:s[1],y});}}
    for(let x=Math.round(w*.18);x<w*.9;x+=4){const s=spans(x,false);if(s){top.push({x,y:s[0]});bottom.push({x,y:s[1]});}}
    const fit=(pts:Point[],horizontal:boolean):BoundaryLine|null=>{
      if(pts.length<12)return null;
      const third=Math.floor(pts.length/3),a=pts.slice(0,third),b=pts.slice(-third);
      const position=(p:Point)=>horizontal?p.x:p.y,value=(p:Point)=>horizontal?p.y:p.x;
      const slope=(median(b.map(value))-median(a.map(value)))/(median(b.map(position))-median(a.map(position)));
      const offset=median(pts.map(p=>value(p)-slope*position(p))),norm=Math.hypot(1,slope);
      return {nx:(horizontal?-slope:1)/norm,ny:(horizontal?1:-slope)/norm,c:offset/norm,support:0,contrast:0,residual:0,frame:false};
    };
    const lines=[fit(top,true),fit(right,false),fit(bottom,true),fit(left,false)];
    if(lines.every((line):line is BoundaryLine=>!!line)){
      const q=lines.map((line,i)=>intersect(lines[(i+3)%4]!,line!));
      if(q.every((p):p is Point=>!!p))result.push(q as QuadPoints);
    }
    for(const hull of findMaskComponentHulls(mask,w,h,w*h*.25,w*h*.995)){
      const q=hull.length===4?orderQuadCorners(hull):fitQuadToContourByLines(hull);
      if(q)result.push(q);
    }
  }
  return result;
}

function sampleRGB(image: DetectionPixels, x: number, y: number, out: Float64Array, offset: number): void {
  const {width:w,height:h,data}=image;
  x=clamp(x,0,w-1);y=clamp(y,0,h-1);
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),tx=x-x0,ty=y-y0;
  const a=(y0*w+x0)*4,b=(y0*w+x1)*4,c=(y1*w+x0)*4,d=(y1*w+x1)*4;
  for(let channel=0;channel<3;channel++)out[offset+channel]=
    (data[a+channel]*(1-tx)+data[b+channel]*tx)*(1-ty)+
    (data[c+channel]*(1-tx)+data[d+channel]*tx)*ty;
}
interface BoundaryLine { nx:number;ny:number;c:number;support:number;contrast:number;residual:number;frame:boolean }
function fitBoundary(image: DetectionPixels, a: Point, b: Point, band: number): BoundaryLine {
  const physical=fitBoundaryPhysical(image,a,b,band);
  if(physical.frame||(physical.support>=.65&&physical.contrast>=9&&physical.residual<=2))return physical;
  // Photos are often framed so tightly that the page runs to within a few percent of the border; no edge exists there to find.
  const {width:w,height:h}=image,mx=Math.max(2,w*.025),my=Math.max(2,h*.025);
  const nearLow=Math.max(a.x,b.x)<mx?'x':Math.max(a.y,b.y)<my?'y':null;
  const nearHigh=Math.min(a.x,b.x)>w-mx?'x':Math.min(a.y,b.y)>h-my?'y':null;
  if(!nearLow&&!nearHigh)return physical;
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),nx=-dy/len,ny=dx/len;
  const c=nearLow?0:nearHigh==='x'?nx*w:ny*h;
  return {nx,ny,c,support:.8,contrast:0,residual:0,frame:true};
}
function fitBoundaryPhysical(image: DetectionPixels, a: Point, b: Point, band: number): BoundaryLine {
  const {width:w,height:h}=image,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  const nx=-dy/len,ny=dx/len,base=nx*a.x+ny*a.y;
  const margin=Math.max(2,Math.max(w,h)*.006);
  const frame = Math.max(a.x,b.x)<margin || Math.min(a.x,b.x)>w-margin || Math.max(a.y,b.y)<margin || Math.min(a.y,b.y)>h-margin;
  if(frame){
    const c=Math.max(a.x,b.x)<margin?0:Math.min(a.x,b.x)>w-margin?nx*w:Math.max(a.y,b.y)<margin?0:ny*h;
    return {nx,ny,c,support:.8,contrast:0,residual:0,frame:true};
  }
  const samples:Array<{t:number;o:number;weight:number;contrast:number;sign:number}>=[];
  const count=Math.min(96,Math.max(32,Math.round(len/12)));
  const broad=Math.max(4,Math.min(9,Math.max(w,h)/220));
  const rgb=new Float64Array(18);
  for(let k=0;k<count;k++){
    const t=.06+.88*k/(count-1),px=a.x+dx*t,py=a.y+dy*t;
    let best=-Infinity,bestO=0,bestContrast=0,bestSign=0;
    const responses:number[]=[];
    for(let o=-band;o<=band;o++){
      const x=px+nx*o,y=py+ny*o;
      if(x<2||y<2||x>w-3||y>h-3){responses.push(0);continue;}
      sampleRGB(image,x+nx*1.5,y+ny*1.5,rgb,0);
      sampleRGB(image,x-nx*1.5,y-ny*1.5,rgb,3);
      sampleRGB(image,x+nx*broad,y+ny*broad,rgb,6);
      sampleRGB(image,x+nx*broad*.65,y+ny*broad*.65,rgb,9);
      sampleRGB(image,x-nx*broad,y-ny*broad,rgb,12);
      sampleRGB(image,x-nx*broad*.65,y-ny*broad*.65,rgb,15);
      let gradient=0,contrast=0,polarity=0;
      for(let c=0;c<3;c++){
        const g=rgb[c]-rgb[3+c];
        const d=(rgb[6+c]+rgb[9+c]-rgb[12+c]-rgb[15+c])/2;
        gradient+=g*g;contrast+=d*d;polarity+=g*d;
      }
      gradient=Math.sqrt(gradient/3);contrast=Math.sqrt(contrast/3);
      // A print stroke has a sharp derivative but little sustained region contrast.
      const response=polarity>0?Math.min(gradient,contrast*1.25):0;
      responses.push(response);
      const score=response/(1+.45*(o/band)**2);
      if(score>best){best=score;bestO=o;bestContrast=contrast;bestSign=rgb[7]-rgb[13];}
    }
    if(best<6||bestContrast<7)continue;
    const i=bestO+band,left=responses[i-1]??responses[i],right=responses[i+1]??responses[i];
    const denom=left-2*responses[i]+right;
    const offset=Math.abs(denom)>1e-6?clamp(.5*(left-right)/denom,-.5,.5):0;
    samples.push({t,o:bestO+offset,weight:best,contrast:bestContrast,sign:bestSign});
  }
  if(samples.length<8)return {nx,ny,c:base,support:0,contrast:0,residual:Infinity,frame:false};
  let intercept=median(samples.map(p=>p.o)),slope=0;
  for(let iteration=0;iteration<4;iteration++){
    const mad=Math.max(1,median(samples.map(p=>Math.abs(p.o-intercept-slope*(p.t-.5))))*1.4826);
    let sw=0,st=0,so=0,stt=0,sto=0;
    for(const p of samples){const t=p.t-.5,r=Math.abs(p.o-intercept-slope*t),weight=Math.min(p.weight,100)*Math.min(1,2*mad/Math.max(.001,r));sw+=weight;st+=weight*t;so+=weight*p.o;stt+=weight*t*t;sto+=weight*t*p.o;}
    const d=sw*stt-st*st;if(Math.abs(d)>1e-8){slope=(sw*sto-st*so)/d;intercept=(so-slope*st)/sw;}
  }
  const inliers=samples.filter(p=>Math.abs(p.o-intercept-slope*(p.t-.5))<Math.max(2.5,Math.max(w,h)*.005));
  const contrast=median(inliers.map(p=>p.contrast));
  const support=inliers.length/count;
  if(support<.45||Math.abs(slope)>band*1.5)return {nx,ny,c:base,support,contrast,residual:Infinity,frame:false};
  const tx=dx/len,ty=dy/len,nxx=nx-slope/len*tx,nyy=ny-slope/len*ty,norm=Math.hypot(nxx,nyy);
  const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2;
  return {nx:nxx/norm,ny:nyy/norm,c:(nxx*midX+nyy*midY+intercept)/norm,support,contrast,residual:median(inliers.map(p=>Math.abs(p.o-intercept-slope*(p.t-.5)))),frame:false};
}
function intersect(a:BoundaryLine,b:BoundaryLine):Point|null {
  const d=a.nx*b.ny-a.ny*b.nx;
  if(Math.abs(d)<.12)return null;
  return {x:(a.c*b.ny-a.ny*b.c)/d,y:(a.nx*b.c-a.c*b.nx)/d};
}
function refine(image:DetectionPixels,q:ScanQuad,band:number){
  const prior=points(q,image.width,image.height),lines=prior.map((a,i)=>fitBoundary(image,a,prior[(i+1)%4],band));
  const next=prior.map((p,i)=>{
    const a=lines[(i+3)%4],b=lines[i];
    if(a.support<.45||b.support<.45||!Number.isFinite(a.residual)||!Number.isFinite(b.residual))return p;
    const v=intersect(a,b);return v&&Math.hypot(v.x-p.x,v.y-p.y)<=band*3?v:p;
  }) as QuadPoints;
  const quad=normalize(next,image.width,image.height);
  return {quad:isSaneQuad(quad)?quad:q,lines};
}

/**
 * Moves each edge of the outline inward until the strip along it is paper rather than desk, cover or sky.
 * White margin may remain; background may not. Edges that already sit on paper, or that would need to
 * move further than a few percent, are left untouched so printed dark bands are never mistaken for background.
 */
export function trimBackgroundEdges(image: DetectionPixels, quad: ScanQuad): ScanQuad {
  const { width: w, height: h, data } = image;
  const pts = points(quad, w, h);
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const at = (x: number, y: number) => {
    const px = Math.min(w - 1, Math.max(0, Math.round(x))), py = Math.min(h - 1, Math.max(0, Math.round(y)));
    const i = (py * w + px) * 4, lo = Math.min(data[i], data[i + 1], data[i + 2]), hi = Math.max(data[i], data[i + 1], data[i + 2]);
    return { lo, chroma: hi - lo };
  };
  const bilinear = (u: number, v: number) => {
    const top = { x: pts[0].x + (pts[1].x - pts[0].x) * u, y: pts[0].y + (pts[1].y - pts[0].y) * u };
    const bottom = { x: pts[3].x + (pts[2].x - pts[3].x) * u, y: pts[3].y + (pts[2].y - pts[3].y) * u };
    return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
  };
  const inner: Array<{ lo: number; chroma: number }> = [];
  for (let u = .15; u <= .85; u += .05) for (let v = .15; v <= .85; v += .05) { const p = bilinear(u, v); inner.push(at(p.x, p.y)); }
  const sortedLo = inner.map(s => s.lo).sort((a, b) => a - b);
  const paperLo = sortedLo[Math.floor(sortedLo.length * .75)] ?? 0;
  const brightChroma = inner.filter(s => s.lo >= paperLo * .85).map(s => s.chroma);
  const paperChroma = median(brightChroma);
  if (paperLo < 60) return quad;
  const isPaper = (x: number, y: number) => { const s = at(x, y); return s.lo >= paperLo * .62 && s.chroma <= paperChroma + 45; };

  const maxTrim = Math.max(4, Math.round(Math.min(w, h) * .05));
  const shifts = pts.map((a, i) => {
    const b = pts[(i + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 8) return 0;
    let nx = -dy / len, ny = dx / len;
    if (nx * (cx - a.x) + ny * (cy - a.y) < 0) { nx = -nx; ny = -ny; }
    const onPaper = (d: number) => {
      const fractions: number[] = [];
      for (let k = 0; k < 4; k++) {
        let paper = 0, total = 0;
        for (let t = .1 + .2 * k; t < .1 + .2 * (k + 1); t += 2 / len) for (let o = 0; o < 3; o++) {
          total++; if (isPaper(a.x + dx * t + nx * (d + o), a.y + dy * t + ny * (d + o))) paper++;
        }
        fractions.push(paper / Math.max(1, total));
      }
      fractions.sort((p, q) => p - q);
      return fractions[1] >= .6 && fractions[0] >= .3;
    };
    if (onPaper(0)) return 0;
    for (let d = 1; d <= maxTrim; d++) if (onPaper(d) && onPaper(d + 1)) return d + 1;
    return 0;
  });
  if (shifts.every(s => s === 0)) return quad;

  const lines = pts.map((a, i) => {
    const b = pts[(i + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    let nx = -dy / len, ny = dx / len;
    if (nx * (cx - a.x) + ny * (cy - a.y) < 0) { nx = -nx; ny = -ny; }
    const sx = a.x + nx * shifts[i], sy = a.y + ny * shifts[i];
    return { nx, ny, c: nx * sx + ny * sy, support: 1, contrast: 0, residual: 0, frame: false } as BoundaryLine;
  });
  const next = pts.map((p, i) => intersect(lines[(i + 3) % 4], lines[i]) ?? p) as QuadPoints;
  const trimmed = normalize(next, w, h);
  const before = polygonArea(points(quad, 1, 1)), after = polygonArea(points(trimmed, 1, 1));
  return isSaneQuad(trimmed) && after >= before * .8 && after <= before ? trimmed : quad;
}

/**
 * Repairs outlines where one side is cut diagonally across the page while the opposite side is clean. When opposite
 * sides diverge by well over a perspective tilt (15 degrees) and paper lies just outside the diverging side, that side is rebuilt parallel to
 * its opposite and pushed outward until the paper actually ends.
 */
export function straightenSkewedEdges(image: DetectionPixels, quad: ScanQuad): ScanQuad {
  const { width: w, height: h, data } = image;
  const pts = points(quad, w, h);
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const lo = (x: number, y: number) => { const i = (y * w + x) * 4; return Math.min(data[i], data[i + 1], data[i + 2]); };
  const chroma = (x: number, y: number) => { const i = (y * w + x) * 4; return Math.max(data[i], data[i + 1], data[i + 2]) - lo(x, y); };
  const interiorLo: number[] = [], interiorChroma: number[] = [];
  for (let u = .15; u <= .85; u += .05) for (let v = .15; v <= .85; v += .05) {
    const tx = pts[0].x + (pts[1].x - pts[0].x) * u, ty = pts[0].y + (pts[1].y - pts[0].y) * u;
    const bx = pts[3].x + (pts[2].x - pts[3].x) * u, by = pts[3].y + (pts[2].y - pts[3].y) * u;
    const x = Math.round(tx + (bx - tx) * v), y = Math.round(ty + (by - ty) * v);
    if (x >= 0 && y >= 0 && x < w && y < h) { interiorLo.push(lo(x, y)); interiorChroma.push(chroma(x, y)); }
  }
  interiorLo.sort((a, b) => a - b);
  const paperLo = interiorLo[Math.floor(interiorLo.length * .75)] ?? 0, paperChroma = median(interiorChroma);
  if (paperLo < 90) return quad;

  const paperFraction = (a: Point, b: Point) => {
    let inside = 0, paper = 0;
    for (let k = 0; k <= 40; k++) {
      const x = Math.round(a.x + (b.x - a.x) * (.1 + .8 * k / 40)), y = Math.round(a.y + (b.y - a.y) * (.1 + .8 * k / 40));
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      inside++;
      if (lo(x, y) >= paperLo * .62 && chroma(x, y) <= paperChroma + 40) paper++;
    }
    return inside < 20 ? null : paper / inside;
  };
  const toLine = (a: Point, b: Point): BoundaryLine => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    return { nx, ny, c: nx * a.x + ny * a.y, support: 1, contrast: 0, residual: 0, frame: false };
  };
  const bearing = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);

  for (const [i, j] of [[0, 2], [1, 3]] as const) {
    let divergence = Math.abs(bearing(pts[i], pts[(i + 1) % 4]) - bearing(pts[(j + 1) % 4], pts[j])) % (2 * Math.PI);
    if (divergence > Math.PI) divergence = 2 * Math.PI - divergence;
    if (divergence * 180 / Math.PI < 15) continue;

    const outside = [i, j].map(edge => {
      const a = pts[edge], b = pts[(edge + 1) % 4], len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      if (nx * (cx - a.x) + ny * (cy - a.y) > 0) { nx = -nx; ny = -ny; }
      const reach = Math.max(4, Math.min(w, h) * .02);
      return paperFraction({ x: a.x + nx * reach, y: a.y + ny * reach }, { x: b.x + nx * reach, y: b.y + ny * reach });
    });
    const badFirst = (outside[0] ?? 0) >= (outside[1] ?? 0);
    if (Math.max(outside[0] ?? 0, outside[1] ?? 0) < .2) continue;
    const bad = badFirst ? i : j, ref = badFirst ? j : i;

    const r0 = pts[ref], r1 = pts[(ref + 1) % 4], refLen = Math.hypot(r1.x - r0.x, r1.y - r0.y) || 1;
    let nx = -(r1.y - r0.y) / refLen, ny = (r1.x - r0.x) / refLen;
    const badMid = { x: (pts[bad].x + pts[(bad + 1) % 4].x) / 2, y: (pts[bad].y + pts[(bad + 1) % 4].y) / 2 };
    if (nx * (badMid.x - r0.x) + ny * (badMid.y - r0.y) < 0) { nx = -nx; ny = -ny; }
    const depth = nx * (badMid.x - r0.x) + ny * (badMid.y - r0.y);
    if (depth < 16) continue;

    const step = Math.max(1, depth / 160);
    const at = (d: number) => paperFraction({ x: r0.x + nx * d, y: r0.y + ny * d }, { x: r1.x + nx * d, y: r1.y + ny * d });
    if ((at(depth * .2) ?? 0) < .6) continue;
    let edgeDepth = -1, misses = 0;
    for (let d = depth * .2; d <= depth * 1.4; d += step) {
      const f = at(d);
      if (f === null) break;
      if (f >= .6) { edgeDepth = d; misses = 0; } else if (f < .4 && ++misses >= 3) break;
    }
    if (edgeDepth < depth * .95 || edgeDepth > depth * 1.35) continue;

    const moved = toLine({ x: r1.x + nx * edgeDepth, y: r1.y + ny * edgeDepth }, { x: r0.x + nx * edgeDepth, y: r0.y + ny * edgeDepth });
    const next = pts.map(p => ({ ...p })) as QuadPoints;
    const first = intersect(toLine(pts[(bad + 3) % 4], pts[bad]), moved);
    const second = intersect(moved, toLine(pts[(bad + 1) % 4], pts[(bad + 2) % 4]));
    if (!first || !second) continue;
    next[bad] = first;
    next[(bad + 1) % 4] = second;
    for (const p of next) { p.x = clamp(p.x, 0, w); p.y = clamp(p.y, 0, h); }
    const repaired = normalize(next, w, h);
    const before = polygonArea(points(quad, 1, 1)), after = polygonArea(points(repaired, 1, 1));
    if (!isSaneQuad(repaired) || after < before * .95 || after > before * 1.5) continue;
    return straightenSkewedEdges(image, repaired);
  }
  return quad;
}

/**
 * Open books and notebooks often yield a single page as the strongest outline because the spine or spiral is a
 * sharper edge than the shadowed outer border of the facing page. When paper of the same kind continues past exactly
 * one side for a comparable page width, while the space above and below that continuation is not paper, the outline
 * is widened across the spine to cover both pages.
 */
export function extendToFacingPage(image: DetectionPixels, quad: ScanQuad): ScanQuad | null {
  const { width: w, height: h, data } = image;
  const pts = points(quad, w, h);
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const lo = (x: number, y: number) => { const i = (y * w + x) * 4; return Math.min(data[i], data[i + 1], data[i + 2]); };
  const chroma = (x: number, y: number) => { const i = (y * w + x) * 4; return Math.max(data[i], data[i + 1], data[i + 2]) - lo(x, y); };
  const interiorLo: number[] = [], interiorChroma: number[] = [];
  for (let u = .1; u <= .9; u += .04) for (let v = .1; v <= .9; v += .04) {
    const tx = pts[0].x + (pts[1].x - pts[0].x) * u, ty = pts[0].y + (pts[1].y - pts[0].y) * u;
    const bx = pts[3].x + (pts[2].x - pts[3].x) * u, by = pts[3].y + (pts[2].y - pts[3].y) * u;
    const x = Math.round(tx + (bx - tx) * v), y = Math.round(ty + (by - ty) * v);
    if (x >= 0 && y >= 0 && x < w && y < h) { interiorLo.push(lo(x, y)); interiorChroma.push(chroma(x, y)); }
  }
  interiorLo.sort((a, b) => a - b);
  const paperLo = interiorLo[Math.floor(interiorLo.length * .75)] ?? 0, paperChroma = median(interiorChroma);
  if (paperLo < 90) return null;

  /** Fraction of in-image samples on a segment that look like this page's paper, or null when the segment is mostly off-image. */
  const paperFraction = (a: Point, b: Point) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(12, Math.round(len / 3));
    let inside = 0, paper = 0;
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(a.x + (b.x - a.x) * k / steps), y = Math.round(a.y + (b.y - a.y) * k / steps);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      inside++;
      if (lo(x, y) >= paperLo * .65 && chroma(x, y) <= paperChroma + 30) paper++;
    }
    return inside < (steps + 1) * .5 ? null : paper / inside;
  };
  const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  type Side = { i: number; distance: number; normal: Point };
  const sides: Array<Side | null> = pts.map((a, i) => {
    const b = pts[(i + 1) % 4], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 16) return null;
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    if (nx * (cx - a.x) + ny * (cy - a.y) > 0) { nx = -nx; ny = -ny; }
    const oa = pts[(i + 2) % 4], ob = pts[(i + 3) % 4];
    const pageWidth = Math.abs(nx * ((oa.x + ob.x) / 2 - (a.x + b.x) / 2) + ny * ((oa.y + ob.y) / 2 - (a.y + b.y) / 2));
    if (pageWidth < 16) return null;
    const step = Math.max(2, pageWidth / 90), gutterLimit = pageWidth * .12, maxReach = pageWidth * 1.6;
    const sa = lerp(a, b, .15), sb = lerp(a, b, .85);
    let runStart = -1, lastPaper = -1, misses = 0, reachedFrame = false;
    for (let d = step; d <= maxReach; d += step) {
      const f = paperFraction({ x: sa.x + nx * d, y: sa.y + ny * d }, { x: sb.x + nx * d, y: sb.y + ny * d });
      if (f === null) { reachedFrame = true; break; }
      if (f >= .7) { if (runStart < 0) runStart = d; lastPaper = d; misses = 0; }
      else if (runStart < 0) { if (d > gutterLimit) return null; }
      else if (f < .45 && ++misses >= 3) break;
    }
    if (runStart < 0) return null;
    const run = lastPaper - runStart;
    // A clipped neighbor has no visible outer boundary and must not enlarge the main page's crop.
    if (reachedFrame || run < pageWidth * .75 || lastPaper > pageWidth * 1.4 || misses < 3) return null;
    const distance = reachedFrame ? Math.min(lastPaper + step, maxReach) : lastPaper + step;
    // A sheet on a pale desk also "continues" sideways; a facing page has non-paper above and below its extension.
    for (const [p, q] of [[a, oa], [b, ob]] as const) {
      const along = { x: p.x - q.x, y: p.y - q.y }, alongLen = Math.hypot(along.x, along.y) || 1;
      const ux = along.x / alongLen, uy = along.y / alongLen, offset = Math.max(4, pageWidth * .04);
      const start = { x: p.x + nx * distance * .25 + ux * offset, y: p.y + ny * distance * .25 + uy * offset };
      const end = { x: p.x + nx * distance * .85 + ux * offset, y: p.y + ny * distance * .85 + uy * offset };
      const f = paperFraction(start, end);
      if (f !== null && f > .5) return null;
    }
    return { i, distance, normal: { x: nx, y: ny } };
  });
  const valid = sides.filter((s): s is Side => !!s);
  // Paper continuing on opposite sides means the outline sits inside a larger sheet, not beside a facing page.
  if (valid.length !== 1) return null;
  const { i, distance, normal } = valid[0];
  const lines = pts.map((a, k) => {
    const b = pts[(k + 1) % 4], len = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    if (nx * (cx - a.x) + ny * (cy - a.y) > 0) { nx = -nx; ny = -ny; }
    const shift = k === i ? distance : 0, sx = a.x + normal.x * shift * Number(k === i), sy = a.y + normal.y * shift * Number(k === i);
    return { nx, ny, c: nx * sx + ny * sy, support: 1, contrast: 0, residual: 0, frame: false } as BoundaryLine;
  });
  const next = pts.map((p, k) => intersect(lines[(k + 3) % 4], lines[k]) ?? p) as QuadPoints;
  for (const p of next) { p.x = clamp(p.x, 0, w); p.y = clamp(p.y, 0, h); }
  const extended = normalize(next, w, h);
  return isSaneQuad(extended) ? extended : null;
}

function partialLeafCandidate(image: DetectionPixels, outer: ScanQuad): {quad: ScanQuad; support: number[]} | null {
  const pts = points(outer, image.width, image.height);
  // Keep tightly framed paper margins instead of mistaking nearby printed header rules for an outer edge.
  for (let i = 0; i < 4; i++) for (const [axis, length] of [['x', image.width], ['y', image.height]] as const) {
    const a = pts[i], b = pts[(i + 1) % 4];
    if (Math.max(a[axis], b[axis]) < length * .025) a[axis] = b[axis] = 0;
    else if (Math.min(a[axis], b[axis]) > length * .975) a[axis] = b[axis] = length;
  }
  const rgb = new Float64Array(3);
  const exposure = paperExposure(image);
  const at = (side: number, depth: number, along: number) => {
    const a = pts[side], b = pts[(side + 1) % 4], c = pts[(side + 3) % 4], d = pts[(side + 2) % 4];
    const x = (a.x + (b.x - a.x) * along) * (1 - depth) + (c.x + (d.x - c.x) * along) * depth;
    const y = (a.y + (b.y - a.y) * along) * (1 - depth) + (c.y + (d.y - c.y) * along) * depth;
    sampleRGB(image, x, y, rgb, 0);
    return Math.min(...rgb) / exposure;
  };
  const patch = (side: number, depth: number, along: number, direction: number, far = false) => {
    const values: number[] = [];
    for (const offset of far ? [.025, .035, .045] : [.006, .012, .018])
      for (const dy of [-.008, 0, .008]) values.push(at(side, depth + direction * offset, along + dy));
    values.sort((a, b) => a - b);
    // Upper quantiles suppress handwriting and thin printed margin rules, but retain broad binding shadows.
    return values[6];
  };
  for (let side = 0; side < 4; side++) {
    const samples: Array<{along: number; depth: number; contrast: number}> = [];
    for (let k = 0; k < 32; k++) {
      const along = .08 + .84 * k / 31;
      let best: {along: number; depth: number; contrast: number} | null = null;
      for (let depth = .04; depth <= .3; depth += .004) {
        const leaf = patch(side, depth, along, -1), shadow = patch(side, depth, along, 1);
        const farLeaf = patch(side, depth, along, -1, true), farShadow = patch(side, depth, along, 1, true);
        const contrast = Math.min(leaf - shadow, leaf - farShadow);
        if (leaf < 175 || shadow < 110 || farLeaf < 160 || contrast < 10 || leaf - farLeaf < 3) continue;
        if (!best || contrast > best.contrast) best = {along, depth, contrast};
      }
      if (best) samples.push(best);
    }
    if (samples.length < 26) continue;
    const first = samples.slice(0, 10), last = samples.slice(-10);
    const slope = (median(last.map(p => p.depth)) - median(first.map(p => p.depth))) / (median(last.map(p => p.along)) - median(first.map(p => p.along)));
    const intercept = median(samples.map(p => p.depth - slope * p.along));
    const inliers = samples.filter(p => Math.abs(p.depth - intercept - slope * p.along) < .016);
    if (inliers.length < 26 || Math.abs(slope) > .2 || intercept < .025 || intercept > .32 || intercept + slope < .025 || intercept + slope > .32) continue;
    const next = pts.map(p => ({...p})) as QuadPoints;
    for (const [corner, opposite, along] of [[side, (side + 3) % 4, 0], [(side + 1) % 4, (side + 2) % 4, 1]]) {
      const depth = intercept + slope * along;
      next[corner] = {x: pts[corner].x + (pts[opposite].x - pts[corner].x) * depth, y: pts[corner].y + (pts[opposite].y - pts[corner].y) * depth};
    }
    const quad = normalize(next, image.width, image.height);
    if (isSaneQuad(quad)) {
      const support = pts.map((a, i) => i === side ? inliers.length / 32 : fitBoundary(image, a, pts[(i + 1) % 4], Math.max(3, Math.round(Math.max(image.width, image.height) * .01))).support);
      if (support.filter(v => v >= .5).length >= 3 && support.reduce((s, v) => s + v, 0) / 4 >= .55) return {quad, support};
    }
  }
  return null;
}

function bounds(q: ScanQuad) {
  const xs = keys.map(k => q[k].x), ys = keys.map(k => q[k].y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** True when `page` is roughly one half of `spread`: about half its width (or height), full the other way, flush with one outer side. */
function isHalfOfSpread(page: ScanQuad, spread: ScanQuad): boolean {
  const a = bounds(page), b = bounds(spread);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  if (bw <= 0 || bh <= 0) return false;
  const half = (along: number, across: number, flushLow: number, flushHigh: number, span: number) =>
    along >= .35 && along <= .65 && across >= .7 && (flushLow < .06 * span || flushHigh < .06 * span);
  return half((a.x1 - a.x0) / bw, (a.y1 - a.y0) / bh, Math.abs(a.x0 - b.x0), Math.abs(a.x1 - b.x1), bw) ||
    half((a.y1 - a.y0) / bh, (a.x1 - a.x0) / bw, Math.abs(a.y0 - b.y0), Math.abs(a.y1 - b.y1), bh);
}

function verifiesFacingPage(image: DetectionPixels, page: ScanQuad, spread: ScanQuad): boolean {
  if (!isHalfOfSpread(page, spread)) return false;
  const a = bounds(page), b = bounds(spread);
  const horizontal = (a.x1 - a.x0) / (b.x1 - b.x0) < .7;
  const low = horizontal ? a.x0 : a.y0, high = horizontal ? a.x1 : a.y1;
  const outerLow = horizontal ? b.x0 : b.y0, outerHigh = horizontal ? b.x1 : b.y1;
  const before = low - outerLow > outerHigh - high;
  const start = before ? outerLow : high, end = before ? low : outerHigh;
  const relativeWidth = (end - start) / (high - low);
  if (relativeWidth < .8 || relativeWidth > 1.15) return false;
  const crossLow = horizontal ? b.y0 : b.x0, crossHigh = horizontal ? b.y1 : b.x1;
  const read = (along: number, across: number) => {
    const x = Math.round((horizontal ? along : across) * (image.width - 1));
    const y = Math.round((horizontal ? across : along) * (image.height - 1));
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    const i = (y * image.width + x) * 4, rgb = image.data.subarray(i, i + 3);
    const lo = Math.min(...rgb);
    return {lo, chroma: Math.max(...rgb) - lo};
  };
  const paper = [];
  for (let u = .15; u < .9; u += .05) for (let v = .12; v < .9; v += .05) {
    const pixel = read(start + (end - start) * u, crossLow + (crossHigh - crossLow) * v);
    if (pixel) paper.push(pixel);
  }
  const brightness = median(paper.map(p => p.lo));
  if (brightness < 90 || paper.filter(p => p.lo > brightness * .65 && p.chroma < 35).length < paper.length * .7) return false;
  // Verify the neighbor's top and bottom against its own exposure, not the brighter selected page.
  for (const cross of [crossLow - .035, crossHigh + .035]) {
    const outside = [];
    for (let u = .2; u < .85; u += .05) {
      const pixel = read(start + (end - start) * u, cross);
      if (pixel) outside.push(pixel);
    }
    if (outside.length && outside.filter(p => p.lo > brightness * .65 && p.chroma < 35).length > outside.length * .4) return false;
  }
  return true;
}

function interiorEdgePenalty(image: DetectionPixels, quad: ScanQuad, exposure: number): number {
  const pts=points(quad,image.width,image.height),rgb=new Float64Array(3);
  const distance=Math.max(3,Math.min(image.width,image.height)*.018);
  const paper=(x:number,y:number,threshold:number)=>{
    if(x<0||y<0||x>=image.width||y>=image.height)return false;
    sampleRGB(image,x,y,rgb,0);
    return Math.min(...rgb)>threshold*exposure&&Math.max(...rgb)-Math.min(...rgb)<35;
  };
  let penalty=0;
  for(let side=0;side<4;side++){
    const a=pts[side],b=pts[(side+1)%4],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),nx=-dy/len,ny=dx/len;
    const longest=Math.max(...pts.map((p,k)=>Math.hypot(pts[(k+1)%4].x-p.x,pts[(k+1)%4].y-p.y)));
    // The long side may be a legitimate binding between facing leaves; only score the shorter page-end edges.
    if(len>longest*.8)continue;
    let crossing=0;
    for(let i=0;i<32;i++){
      const t=.08+.84*i/31,x=a.x+dx*t,y=a.y+dy*t;
      let inside=0,outside=0;
      for(const scale of [.75,1,1.5]){
        const ox=nx*distance*scale,oy=ny*distance*scale;
        if(paper(x+ox,y+oy,150))inside++;
        if(paper(x-ox,y-oy,110))outside++;
      }
      if(inside>=2&&outside>=2)crossing++;
    }
    // Shadowed paper beyond a line is evidence of an interior rule, not an outer page boundary.
    penalty+=Math.max(0,crossing/32-.25)*.2;
  }
  return penalty;
}

export function detectPrecisionDocument(image: DetectionPixels): DocumentDetectionResult {
  const start=performance.now(),{width,height}=image;
  if(width<16||height<16||image.data.length!==width*height*4)throw new Error('Invalid detection pixels');
  const medium=resizeDetectionPixels(image,720),coarse=resizeDetectionPixels(medium,420),field=prepareEdgeFieldFromPixels(coarse.data,coarse.width,coarse.height);
  const collected:Array<{source:string;score:number;pts:QuadPoints}>=[];
  const legacy=detectDocumentSpreadFromField(field,collected,true);
  const candidates=collected.filter(c=>!c.source.startsWith('full_prior')).map(c=>({quad:normalize(c.pts,coarse.width,coarse.height),source:c.source,score:c.score}));
  // Extra proposals are made at coarse scale; the 720px refinement below snaps whichever survives onto the real edge.
  for(const pts of cannyCandidates(field))candidates.push({quad:normalize(pts,coarse.width,coarse.height),source:'canny',score:scoreQuadCandidate(pts,field)});
  for(const pts of colorCandidates(coarse))candidates.push({quad:normalize(pts,coarse.width,coarse.height),source:'color-region',score:scoreQuadCandidate(pts,field)});
  for(const pts of paperCandidates(coarse))candidates.push({quad:normalize(pts,coarse.width,coarse.height),source:'paper-region',score:scoreQuadCandidate(pts,field)});
  candidates.sort((a,b)=>Number(b.source==='paper-region')-Number(a.source==='paper-region')||b.score-a.score);
  const distinct:typeof candidates=[];
  for(const c of candidates){if(!isSaneQuad(c.quad))continue;if(distinct.some(d=>keys.reduce((s,k)=>s+Math.hypot(c.quad[k].x-d.quad[k].x,c.quad[k].y-d.quad[k].y),0)/4<.008))continue;distinct.push(c);if(distinct.length===10)break;}
  const outerPaper=candidates.filter(c=>c.source==='paper-region'&&isSaneQuad(c.quad)).sort((a,b)=>polygonArea(points(b.quad,1,1))-polygonArea(points(a.quad,1,1)))[0];
  const band=Math.max(5,Math.round(Math.max(medium.width,medium.height)*.028));
  const leafQuad=outerPaper ? partialLeafCandidate(medium,refine(medium,outerPaper.quad,band).quad) : null;
  const exposure=paperExposure(medium);
  const evaluated=distinct.map(c=>{
    const first=refine(medium,c.quad,band),polished=refine(medium,first.quad,Math.max(3,Math.round(band/5)));
    const firstSupport=first.lines.reduce((s,l)=>s+l.support,0),secondSupport=polished.lines.reduce((s,l)=>s+l.support,0);
    const r=secondSupport>=firstSupport-.05?polished:first;
    const support=r.lines.map(l=>l.support),physical=r.lines.filter(l=>!l.frame&&l.support>=.7&&l.contrast>=9&&l.residual<=2);
    const min=Math.min(...support),avg=support.reduce((s,v)=>s+v,0)/4;
    const area=polygonArea(points(r.quad,1,1));
    const frameEdges=r.lines.filter(l=>l.frame).length;
    const open=4-frameEdges;
    // With most sides flush to the photo border, the few remaining sides are the whole evidence; they must all be real edges.
    const quality:DetectionQuality=frameEdges>=3
      ?(open>=1&&physical.length>=open&&min>=.65?'review':'none')
      :physical.length>=Math.max(2,open)&&min>=.65?'strong':physical.length>=2&&avg>.45?'review':'none';
    const contrast=median(physical.map(l=>l.contrast));
    // Perimeter coverage dominates shape priors; prefer the supported outer page to a table.
    const rank=avg*.55+min*.25+Math.min(1,contrast/60)*.1+Math.sqrt(area)*.1-interiorEdgePenalty(medium,r.quad,exposure);
    return {...c,...r,support,quality,rank};
  }).filter(c=>c.quality!=='none').sort((a,b)=>b.rank-a.rank);
  // A single page of an open book can out-score the spread on edge support; cropping to it would discard the other page.
  const completePage=evaluated[0]&&evaluated.slice(1).find(c=>{
    if(c.source!=='paper-region'||c.quality!=='strong')return false;
    const a=bounds(c.quad),b=bounds(evaluated[0].quad);
    const besidePartial=(low:number,high:number,outerLow:number,outerHigh:number,crossLow:number,crossHigh:number,outerCrossLow:number,outerCrossHigh:number)=>{
      const page=high-low,span=outerHigh-outerLow,extra=span-page;
      return page/span>=.4&&page/span<=.85&&Math.abs(crossLow-outerCrossLow)<.02&&Math.abs(crossHigh-outerCrossHigh)<.02&&
        (Math.abs(low-outerLow)<.02||Math.abs(high-outerHigh)<.02)&&
        (extra<page*.75||outerLow<.015||outerHigh>.985);
    };
    return (besidePartial(a.x0,a.x1,b.x0,b.x1,a.y0,a.y1,b.y0,b.y1)||besidePartial(a.y0,a.y1,b.y0,b.y1,a.x0,a.x1,b.x0,b.x1))&&!extendToFacingPage(medium,c.quad);
  });
  const principal=completePage??evaluated[0];
  const independentlyLitSpread=principal&&evaluated.find(c=>c!==principal&&verifiesFacingPage(medium,principal.quad,c.quad));
  const facingSpread=principal ? extendToFacingPage(medium,principal.quad) : null;
  const enclosingSpread=independentlyLitSpread??(facingSpread&&evaluated.find(c=>c!==principal&&isHalfOfSpread(principal.quad,c.quad)&&keys.reduce((s,k)=>s+Math.hypot(c.quad[k].x-facingSpread[k].x,c.quad[k].y-facingSpread[k].y),0)/4<.04));
  const leaf=leafQuad&&evaluated[0]?{...evaluated[0],...leafQuad,source:'partial-leaf-binding',quality:'review' as DetectionQuality}:null;
  const preferred=leaf??enclosingSpread??completePage;
  const ordered=preferred?[preferred,...evaluated.filter(c=>c!==preferred)]:evaluated;
  const best=ordered[0];
  const agreement=best?candidates.filter(c=>keys.reduce((s,k)=>s+Math.hypot(c.quad[k].x-best.quad[k].x,c.quad[k].y-best.quad[k].y),0)/4<.02).map(c=>c.source.split('_')[0]):[];
  let quality=best?.quality??'none';
  if(best&&quality==='strong'&&new Set(agreement).size<2)quality='review';
  const runnerUp=ordered.slice(1).find(c=>!isHalfOfSpread(c.quad,best.quad));
  if(best&&runnerUp&&best.rank-runnerUp.rank<.035&&keys.reduce((s,k)=>s+Math.hypot(best.quad[k].x-runnerUp.quad[k].x,best.quad[k].y-runnerUp.quad[k].y),0)/4>.06)quality='review';
  const nearLegacy=best&&keys.reduce((s,k)=>s+Math.hypot(best.quad[k].x-legacy.fullQuad[k].x,best.quad[k].y-legacy.fullQuad[k].y),0)/4<.04;
  let bestQuad=best?.quad;
  if(best&&!leaf){
    const fine=refine(image,best.quad,Math.max(3,Math.round(Math.max(width,height)*.005)));
    const drift=keys.reduce((s,k)=>s+Math.hypot(fine.quad[k].x-best.quad[k].x,fine.quad[k].y-best.quad[k].y),0)/4;
    if(drift<.012&&fine.lines.reduce((s,l)=>s+l.support,0)>=best.support.reduce((s,v)=>s+v,0)-.1)bestQuad=fine.quad;
  }
  if(best&&bestQuad&&!enclosingSpread&&!leaf){
    const spread=extendToFacingPage(medium,bestQuad);
    if(spread){
      const snapped=refine(medium,refine(medium,spread,band).quad,Math.max(3,Math.round(band/5))).quad;
      bestQuad=snapped;
    }
  }
  const finalQuad=best&&bestQuad?trimBackgroundEdges(medium,straightenSkewedEdges(medium,bestQuad)):null;
  return {quad:finalQuad,quality,edgeSupport:best?.support??[0,0,0,0],source:best?.source??'none',reason:quality==='strong'?'Page boundaries verified':quality==='review'?'Check edges before applying':'No reliable page boundary found',twoPageDetails:!leaf&&nearLegacy&&legacy.twoPageDetails?{...legacy.twoPageDetails,fullQuad:finalQuad!}:null,width,height,localEdges:prepareLocalEdges(medium.data,medium.width,medium.height),durationMs:performance.now()-start};
}
