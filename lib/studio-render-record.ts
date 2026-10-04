import {randomUUID} from 'node:crypto'
import {recoveryIdentity} from './studio-access.ts'
export type SavedRender={id:string;projectId:string;createdAt:string;revision:string;image:string;source:string;style:string}
export type RenderIO={list:(prefix:string)=>Promise<string[]>;read:(path:string)=>Promise<string>;write:(path:string,data:string)=>Promise<void>}
const validId=(s:string)=>typeof s==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(s)
const fileId=(s:string)=>/^\d{13}-[a-f0-9-]{36}$/.test(s)
export function renderPrefix(owner:string,projectId:string){recoveryIdentity(owner);if(!validId(projectId))throw new Error('Invalid project.');return owner+'/'+projectId}
export function validSavedRender(v:any):v is SavedRender{return !!v&&fileId(v.id)&&validId(v.projectId)&&Number.isFinite(Date.parse(v.createdAt))&&typeof v.revision==='string'&&v.revision.length<=200000&&typeof v.style==='string'&&v.style.length<=1500&&typeof v.image==='string'&&v.image.length<=24000100&&/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.image)&&typeof v.source==='string'&&v.source.length<=6000000&&/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.source)}
/** The authenticated owner comes from the server, never request JSON. */
export function createRenderRepository(io:RenderIO,authorize:(owner:string,projectId:string)=>Promise<void>){
 async function scope(owner:string,projectId:string){const prefix=renderPrefix(owner,projectId);await authorize(owner,projectId);return prefix}
 return {
  async list(owner:string,projectId:string){const prefix=await scope(owner,projectId);return (await io.list(prefix)).filter(n=>n.endsWith('.json')&&fileId(n.slice(0,-5))).sort().reverse().map(n=>({id:n.slice(0,-5),createdAt:new Date(Number(n.slice(0,13))).toISOString()}))},
  async read(owner:string,projectId:string,id:string){const prefix=await scope(owner,projectId);if(!fileId(id))throw new Error('Invalid image identifier.');const value=JSON.parse(await io.read(prefix+'/'+id+'.json'));if(!validSavedRender(value)||value.projectId!==projectId||value.id!==id)throw new Error('Saved image is invalid.');return value},
  async save(owner:string,record:Omit<SavedRender,'id'|'createdAt'>){const prefix=await scope(owner,record.projectId);if((await io.list(prefix)).length>=20)throw new Error('This project already has 20 saved images. Download the new image to keep it.');const now=Date.now(),value={...record,id:now+'-'+randomUUID(),createdAt:new Date(now).toISOString()};if(!validSavedRender(value))throw new Error('The generated image cannot be saved.');await io.write(prefix+'/'+value.id+'.json',JSON.stringify(value));return value}
 }
}
