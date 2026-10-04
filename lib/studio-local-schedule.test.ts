import test from 'node:test'
import assert from 'node:assert/strict'
import {localScheduleReading} from './studio-local-schedule.ts'
const row=(location='KITCHEN',total='$220.00')=>`Mixer\n${location}\n-\nExample tap\nProduct Name\nBrand name\nBrand\n$110.00\nUnit RRP\n${total}\nTotal RRP\n$110.00\nClient Unit\n${total}\nClient Total\nSupplier\nSupplier Company\nemail@example.com\nSupplier Email`
const read=(text:string)=>localScheduleReading({id:'a'.repeat(64),name:'Fixtures.pdf',pages:[{page:1,text}]})
test('labelled schedule extracts quantity arithmetic and preserves unknown tax',()=>{const d=read('Category\n$999.00\n$0.00\ntax\n'+row());assert.equal(d.items.length,1);assert.equal(d.items[0].quantity,2);assert.equal(d.items[0].price,110);assert.equal(d.items[0].tax,'unknown');assert.equal(d.items[0].name,'Mixer — KITCHEN')})
test('alternatives and zero totals never become assumed quantities',()=>{assert.equal(read(row('KITCHEN OPTION')).items[0].quantity,null);assert.equal(read(row('KITCHEN','$0.00')).items[0].quantity,null)})
test('row boundaries preserve multiple products without importing category totals',()=>{const d=read(row()+'\n'+row('LAUNDRY','$330.00'));assert.equal(d.items.length,2);assert.deepEqual(d.items.map(i=>i.quantity),[2,3])})
test('unsupported drawings do not invent a takeoff',()=>{const d=read('Site plan 1:100 proposed works');assert.equal(d.items.length,0);assert.match(d.warnings[0],/Visual plan interpretation/)})
