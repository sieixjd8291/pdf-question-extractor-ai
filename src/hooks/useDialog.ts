import {useEffect,useRef} from 'react';
export function useDialog(onClose:()=>void,active=true){
 const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{
  if(!active||!ref.current)return;
  const el=ref.current,previous=document.activeElement as HTMLElement|null;
  const targets=()=>Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(x=>x.getClientRects().length);
  (targets()[0]||el).focus();
  const handler=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close.current();}if(e.key!=='Tab')return;const a=targets(),first=a[0],last=a[a.length-1];if(!first){e.preventDefault();el.focus();return;}if(e.shiftKey&&(document.activeElement===first||document.activeElement===el)){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}};
  el.addEventListener('keydown',handler);return()=>{el.removeEventListener('keydown',handler);previous?.focus();};
 },[active]);return ref;
}
