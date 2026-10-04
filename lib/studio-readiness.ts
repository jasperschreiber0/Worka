import type {Revision,Line} from './project-studio.ts'
import {quantity} from './project-studio.ts'
import {levels,unresolvedChecks} from './studio-geometry.ts'
export function itemReadiness(l:Line,r:Revision){
 if(!l.included)return 'Excluded'
 if(quantity(l,r.design)<=0)return 'Needs quantity'
 if(l.rate+(l.labour||0)<=0)return 'Unpriced'
 if(l.quantityVerified===false)return 'Check quantity'
 if(!l.rateVerified)return 'Check rate'
 return l.allowance?'Reviewed allowance':'Reviewed'
}
export function estimateReadiness(r:Revision){
 const included=r.lines.filter(l=>l.included),g=r.design.geometry
 return {included:included.length,unpriced:included.filter(l=>l.rate+(l.labour||0)<=0).length,missingQuantities:included.filter(l=>quantity(l,r.design)<=0).length,uncheckedQuantities:included.filter(l=>l.quantityVerified===false).length,uncheckedRates:included.filter(l=>!l.rateVerified).length,allowances:included.filter(l=>l.allowance).length,modelReviewed:!!g&&levels(g).every(l=>l.geometry.verified)&&unresolvedChecks(g).length===0}
}
