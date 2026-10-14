import {Loader2,FileText,CheckCircle2} from 'lucide-react';
import {PageData} from '../types';
interface Props{currentPage:number;totalPages:number;currentStep:string;percent:number;pages:PageData[];}
export function ProcessingProgress({currentPage,totalPages,currentStep,percent,pages}:Props){
 const progress=Math.min(100,Math.max(0,Number.isFinite(percent)?percent:0));
 return <section className="processing-card"><span className="upload-icon"><Loader2 className="spinner" size={28}/></span><span className="eyebrow">DOCUMENT IN PROGRESS</span><h1>Preparing your document</h1><p role="status">{currentStep||'Reading your PDF…'}</p><div className="progress-meta"><span>Page {currentPage} of {Math.max(totalPages,1)}</span><strong>{Math.round(progress)}%</strong></div><div className="progress-track" role="progressbar" aria-label="Document processing" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{width:`${progress}%`}}/></div>{pages.length>0&&<p className="processing-summary"><CheckCircle2 size={17}/>{pages.filter(p=>p.status==='completed').length} of {pages.length} pages analyzed</p>}<div className="processing-tip"><FileText size={17}/><span>Keep this tab open. Larger documents may take a little longer.</span></div></section>;
}
