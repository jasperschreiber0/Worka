import test from 'node:test'
import assert from 'node:assert/strict'
import {pdfTextRuns} from './studio-pdf-text.ts'
const glyph=(str:string,x:number,y=10)=>({str,width:4.4,transform:[8,0,0,8,x,y],fontName:'CAD'})
test('reassembles shuffled CAD glyphs without joining separate dimensions',()=>{
 const runs=pdfTextRuns([glyph('2',8.8),glyph('2',0),glyph('0',4.4),glyph('0',13.2),glyph('3',17.6),glyph('9',100),glyph('0',104.4),glyph('0',108.8)])
 assert.deepEqual(runs.map(i=>i.str),['20203','900']);assert.equal(runs[0].transform[4],0);assert.equal(runs[0].width,22)
})
test('preserves separate baselines and rotated printed dimensions',()=>{
 const vertical=[0,1,2,3].map((n)=>({...glyph('1200'[n],10),transform:[0,8,-8,0,10,20+n*4.4]}))
 assert.deepEqual(pdfTextRuns([...vertical,glyph('A',0),glyph('B',0,30)]).map(i=>i.str),['1200','A','B'])
})
test('ordinary schedule text is left untouched',()=>{const items=[{str:'Product Name'},{str:'Client Unit Price'},glyph('2',0)];assert.equal(pdfTextRuns(items),items)})
