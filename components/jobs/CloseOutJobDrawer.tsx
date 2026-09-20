'use client'
import Link from 'next/link'
export interface KnowledgeUpdate {trade_name:string;unit:string;previous_rate:number;new_rate:number;variance_pct:number}
export interface CloseOutResult {demo:boolean;already_reconciled:boolean;knowledge_updates:KnowledgeUpdate[]}
export default function CloseOutJobDrawer({open,jobId,onClose}:{open:boolean;jobId:string;onClose:()=>void;onClosed:(result:CloseOutResult)=>void}) {
  if(!open)return null
  return <div role="dialog" aria-modal="true" aria-label="Complete job" className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{background:'rgba(0,0,0,.65)'}}><div className="card p-6 max-w-lg"><h2>Complete and review this job</h2><p className="my-4">Reconcile the saved cost ledger, outstanding commitments, labour and GST in one review. Completion records your approved outcome; future estimates only use adjustments you explicitly approve.</p><Link className="btn-primary inline-block px-4 py-2" href={'/jobs/'+jobId+'/profitability#review'}>Open completion review</Link><button className="btn-secondary ml-3 px-4 py-2" onClick={onClose}>Cancel</button></div></div>
}
