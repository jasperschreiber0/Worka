import type {Workspace} from './studio-workspace.ts'
import {revise,financials,totals} from './project-studio.ts'
import {levels,replaceLevel} from './studio-geometry.ts'
export function omitWallProposal(w:Workspace,wallId:string,extraCost:number){
 if(!Number.isFinite(extraCost)||extraCost<0||extraCost>10000000)throw new Error('Enter a valid additional-work allowance.')
 const r=w.project.working,g=r.design.geometry
 const level=g&&levels(g).find(l=>l.geometry.walls.some(w=>w.id===wallId))
 if(!g||!level)throw new Error('Choose a wall in the current model.')
 const wall=level.geometry.walls.find(w=>w.id===wallId)!
 if(!r.lines.some(l=>l.wallId===wallId&&l.included))throw new Error('This wall has no included linked cost items. Add or link its scope before pricing its omission.')
 const geometry=replaceLevel(g,level.id,{...level.geometry,verified:false,walls:level.geometry.walls.filter(w=>w.id!==wallId)})
 const lines=r.lines.map(l=>l.wallId===wallId?{...l,included:false}:l)
 if(extraCost>0)lines.push({id:'meeting-extra-'+crypto.randomUUID(),trade:'Structure',name:'Additional work for omitting '+wall.name,unit:'item',quantity:1,source:'entered',rate:extraCost,labour:0,waste:0,included:true,allowance:true,rateVerified:false,note:'Unverified discussion allowance for beam/support, redesign, services, demolition or making good as applicable. Not an engineering design.'})
 if(lines.length>500)throw new Error('The project has reached its scope-item limit.')
 return {...w,project:revise(w.project,{design:{...r.design,geometry},lines,impactReview:[],exclusions:r.exclusions+'\nProposed wall omission: '+wall.name+'. Additional work allowance ex GST: $'+extraCost+'. Confirm structural support, services, making good and construction stage. Floor/room footprints unchanged; review room layouts separately.'})}
}
export function meetingFinancials(w:Workspace){
 const current=financials(w.project),proposed=financials({...w.project,baseline:null,variations:[]}),selling=totals(w.project.working)
 return {current,proposed,proposedSelling:selling.price}
}
