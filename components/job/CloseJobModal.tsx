'use client'
import CloseOutJobDrawer from '@/components/jobs/CloseOutJobDrawer'
import type { JobCostRow } from '@/lib/job-closeout'
export interface CloseJobOverview {contract_value:number|null;actual_cost:number;current_margin:number|null;current_margin_pct:number|null;invoiced:number;paid:number;outstanding:number}
export interface CloseJobResult {already_reconciled:boolean;demo:boolean}
export interface CloseJobModalProps {isOpen:boolean;onClose:()=>void;onClosed:(result:CloseJobResult)=>void;job:{id:string;address:string};quoteId:string|null;overview:CloseJobOverview;costs:JobCostRow[]}
export default function CloseJobModal(p:CloseJobModalProps){return <CloseOutJobDrawer open={p.isOpen} jobId={p.job.id} onClose={p.onClose} onClosed={p.onClosed}/>}
