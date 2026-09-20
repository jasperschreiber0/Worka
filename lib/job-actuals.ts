import type {ActualRow} from './profitability.ts'
type Labour={id:string;trade_category_id?:number|null;note?:string|null;hours:number|string;hourly_rate:number|string|null;work_date?:string}
/** Shared cost basis for Money, the business control centre and post-mortems. */
export function jobActuals(costs:ActualRow[],labour:Labour[],labourIncluded:boolean):ActualRow[]{
 return [...costs,...(labourIncluded?[]:labour.filter(l=>l.hourly_rate!=null).map(l=>({id:l.id,trade_category_id:l.trade_category_id??null,description:l.note||'Site labour',amount:Number(l.hours)*Number(l.hourly_rate),labour_hours:Number(l.hours),labour_cost:Number(l.hours)*Number(l.hourly_rate),incurred_on:l.work_date,source_ref:'Site hours'})))]
}
