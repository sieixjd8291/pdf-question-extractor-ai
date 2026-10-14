import type { Point, QuadCorner, EdgeSnapEngine } from './edgeDetector';

export interface LocalEdgeField { width:number; height:number; horizontal:Float32Array; vertical:Float32Array }
export function prepareLocalEdges(data:Uint8ClampedArray,width:number,height:number):LocalEdgeField {
  const horizontal=new Float32Array(width*height),vertical=new Float32Array(width*height);
  const response=(i:number,stride:number)=>{
    const p2=i+stride*2,m2=i-stride*2,p4=i+stride*4,m4=i-stride*4,p6=i+stride*6,m6=i-stride*6;
    let sharp=0,broad=0,polarity=0;
    for(let c=0;c<3;c++){
      const g=data[p2+c]-data[m2+c];
      const d=(data[p6+c]+data[p4+c]-data[m6+c]-data[m4+c])/2;
      sharp+=g*g;broad+=d*d;polarity+=g*d;
    }
    return polarity>0?Math.min(Math.sqrt(sharp/3),Math.sqrt(broad/3)*1.25):0;
  };
  const rowStride=width*4;
  for(let y=6;y<height-6;y++)for(let x=6;x<width-6;x++){
    const i=y*width+x;horizontal[i]=response(i*4,rowStride);vertical[i]=response(i*4,4);
  }
  return {width,height,horizontal,vertical};
}

export function createLocalSnapEngine(field:LocalEdgeField):EdgeSnapEngine {
  const {width:fw,height:fh,horizontal,vertical}=field;
  const read=(x:number,y:number,nx:number,ny:number)=>{
    const fx=Math.round(x*fw),fy=Math.round(y*fh);
    if(fx<6||fy<6||fx>=fw-6||fy>=fh-6)return 0;
    const i=fy*fw+fx;
    return Math.abs(nx)*vertical[i]+Math.abs(ny)*horizontal[i];
  };
  return {autoQuad:null,twoPageSpread:null,
    snapPoint(p:Point,_corner:QuadCorner,w:number,h:number,radius=22){
      if(w<=0||h<=0||radius<=0)return {...p,snapped:false};
      let best=0,target:Point|null=null;
      const rx=Math.ceil(radius*fw/w),ry=Math.ceil(radius*fh/h);
      for(let y=Math.max(6,Math.floor(p.y*fh-ry));y<=Math.min(fh-7,Math.ceil(p.y*fh+ry));y++){
        for(let x=Math.max(6,Math.floor(p.x*fw-rx));x<=Math.min(fw-7,Math.ceil(p.x*fw+rx));x++){
          const distance=Math.hypot((x/fw-p.x)*w,(y/fh-p.y)*h);
          if(distance>radius)continue;
          const i=y*fw+x;
          for(const isHorizontal of [true,false]){
            const values=isHorizontal?horizontal:vertical,normal=isHorizontal?fw:1;
            if(values[i]<10||values[i]<values[i-normal]||values[i]<values[i+normal])continue;
            const along=isHorizontal?1:fw;
            let supported=0;
            for(const d of [-4,-2,0,2,4]){
              const j=i+d*along;
              if(j>=normal&&j<values.length-normal&&Math.max(values[j-normal],values[j],values[j+normal])>=10)supported++;
            }
            if(supported<4)continue;
            const score=Math.min(100,values[i])*(supported/5)/(1+3*(distance/radius)**2);
            if(score>best){best=score;target={x:x/fw,y:y/fh};}
          }
        }
      }
      return target?{...target,snapped:true,type:'ridge'}:{...p,snapped:false};
    },
    snapEdge(a:Point,b:Point,w:number,h:number,radius=22){
      const dx=(b.x-a.x)*w,dy=(b.y-a.y)*h,len=Math.hypot(dx,dy);
      if(len<40||w<=0||h<=0||radius<=0)return {a,b,snapped:false};
      const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      let best=0,target:{a:Point;b:Point}|null=null;
      for(const angle of [-4,-2,0,2,4]){
        const theta=angle*Math.PI/180,ux=(dx*Math.cos(theta)-dy*Math.sin(theta))/len,uy=(dx*Math.sin(theta)+dy*Math.cos(theta))/len,nx=-uy,ny=ux;
        for(let offset=-Math.floor(radius);offset<=radius;offset++){
          const pa={x:mx+(nx*offset-ux*len/2)/w,y:my+(ny*offset-uy*len/2)/h};
          const pb={x:mx+(nx*offset+ux*len/2)/w,y:my+(ny*offset+uy*len/2)/h};
          const distance=Math.max(Math.hypot((pa.x-a.x)*w,(pa.y-a.y)*h),Math.hypot((pb.x-b.x)*w,(pb.y-b.y)*h));
          if(distance>radius||[pa,pb].some(p=>p.x<0||p.x>1||p.y<0||p.y>1))continue;
          let supported=0,sum=0;
          for(let i=0;i<24;i++){
            const t=.08+.84*i/23,x=pa.x+(pb.x-pa.x)*t,y=pa.y+(pb.y-pa.y)*t;
            const response=Math.max(read(x,y,nx,ny),read(x+nx/w,y+ny/h,nx,ny),read(x-nx/w,y-ny/h,nx,ny));
            if(response>=10)supported++;
            sum+=Math.min(100,response);
          }
          if(supported<15)continue;
          const score=sum/24*(supported/24)/(1+1.5*(distance/radius)**2);
          if(score>best){best=score;target={a:pa,b:pb};}
        }
      }
      return target?{...target,snapped:true,type:'ridge'}:{a,b,snapped:false};
    },
  };
}
