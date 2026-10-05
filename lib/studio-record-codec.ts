import {gzipSync,gunzipSync} from 'node:zlib'
import type {StoredWorkspace} from './studio-workspace'

const encoding='worka-record-gzip-v1'
// Storage-only encoding: API callers and backups receive the full original record.
export function encodeStoredRecord(record:StoredWorkspace){
 const images:string[]=[],indices=new Map<string,number>()
 const json=JSON.stringify(record,(_key,value)=>{
  if(typeof value!=='string'||!value.startsWith('data:image/'))return value
  let index=indices.get(value)
  if(index===undefined){index=images.length;images.push(value);indices.set(value,index)}
  return {__workaImage:index}
 })
 return {encoding,version:record.version,payload:gzipSync(JSON.stringify({images,record:JSON.parse(json)})).toString('base64')}
}
export function decodeStoredRecord(value:any):StoredWorkspace{
 if(value?.encoding!==encoding){if(value?.encoding)throw new Error('Unsupported saved project format.');return value}
 const packed=JSON.parse(gunzipSync(Buffer.from(value.payload,'base64'),{maxOutputLength:160*1024*1024}).toString('utf8'))
 if(!Array.isArray(packed.images))throw new Error('Saved drawing references are invalid.')
 const record=JSON.parse(JSON.stringify(packed.record),(_key,item)=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||!Object.hasOwn(item,'__workaImage'))return item
  if(Object.keys(item).length!==1||!Number.isInteger(item.__workaImage)||typeof packed.images[item.__workaImage]!=='string')throw new Error('Saved drawing reference is missing.')
  return packed.images[item.__workaImage]
 })
 if(record.version!==value.version||!record.workspace||!Array.isArray(record.history))throw new Error('Saved project is incomplete.')
 return record
}
