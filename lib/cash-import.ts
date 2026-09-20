import ExcelJS from 'exceljs'
import { addDays, legacyCashPlan, type CashPlan } from './cash-plan.ts'
// Read cached Excel results only: never evaluate formulas, external links or macros.
export async function previewCashWorkbook(buffer: Buffer, firstWeekEnd: string) {
  // Bound expanded ZIP size before ExcelJS parses XML. Reject ZIP64 and malformed directories.
  let end=-1
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--) if(buffer.readUInt32LE(i)===0x06054b50){end=i;break}
  if(end<0) throw new Error('Invalid Excel workbook')
  const count=buffer.readUInt16LE(end+10);let offset=buffer.readUInt32LE(end+16),expanded=0
  if(count>2000) throw new Error('Workbook has too many embedded files')
  for(let i=0;i<count;i++){
    if(offset+46>buffer.length||buffer.readUInt32LE(offset)!==0x02014b50) throw new Error('Invalid workbook directory')
    expanded+=buffer.readUInt32LE(offset+24)
    if(expanded>30_000_000) throw new Error('Workbook expands beyond the 30 MB limit')
    offset+=46+buffer.readUInt16LE(offset+28)+buffer.readUInt16LE(offset+30)+buffer.readUInt16LE(offset+32)
  }
  const workbook=new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const sheet=workbook.getWorksheet('Cashflow Summary')
  if(!sheet || !String(sheet.getCell('A4').text).toLowerCase().includes('cash in') || !String(sheet.getCell('A5').text).toLowerCase().includes('cash out')) throw new Error('Expected the Cashflow Summary layout with Cash In on row 4 and Cash Out on row 5')
  const numeric=(row:number,col:number)=>{
    const cell=sheet.getCell(row,col), v=cell.value
    // ExcelJS's value serializer omits cached zero; the result getter preserves it.
    const value=cell.type===ExcelJS.ValueType.Formula?cell.result:v
    if(typeof value!=='number'||!Number.isFinite(value)) throw new Error(`Missing numeric value at ${cell.address}. Recalculate and save the workbook in Excel first.`)
    return value
  }
  const date=(col:number)=>{
    const v=sheet.getCell(2,col).value, value=typeof v==='object'&&v!==null&&'result' in v?v.result:v
    return value instanceof Date?value.toISOString().slice(0,10):typeof value==='number'?new Date(Date.UTC(1899,11,30)+value*86400000).toISOString().slice(0,10):''
  }
  let start=0
  for(let col=2;col<=Math.min(sheet.columnCount,200);col++) if(date(col)===firstWeekEnd){start=col;break}
  if(!start) throw new Error('Choose a week-ending date present in row 2 of Cashflow Summary')
  const weeks=Array.from({length:13},(_,i)=>{
    if(date(start+i)!==addDays(firstWeekEnd,7*i)) throw new Error('The selected window needs 13 consecutive weekly columns')
    const inflow=numeric(4,start+i),outflow=numeric(5,start+i)
    if(inflow<0||outflow<0) throw new Error('Negative weekly totals need manual review before import')
    const opening=numeric(3,start+i),closing=numeric(6,start+i)
    if(Math.abs(opening+inflow-outflow-closing)>0.02) throw new Error(`Opening cash and movements do not reconcile in column ${sheet.getColumn(start+i).letter}`)
    if(i>0 && Math.abs(opening-numeric(6,start+i-1))>0.02) throw new Error('Weekly balances do not roll forward consistently')
    return {inflow,outflow}
  })
  const plan:CashPlan=legacyCashPlan({opening:numeric(3,start),startOn:addDays(firstWeekEnd,-6),weeks})
  plan.accounts='Main account from Cashflow Summary — confirm account name'
  plan.entries=plan.entries.map(e=>({...e,note:`Cashflow Summary rows 4–5, week ending ${e.expectedOn}. Cached weekly total; confirm forecast versus actual and replace total before adding its detailed payments.`}))
  return {plan,warnings:['Imports only main-account opening cash and 13 weekly totals. Other accounts and available-credit totals are excluded.','Credit-card balances are not deducted automatically. Include future card settlements once, and check transfers between included accounts.','These are saved Excel values, not refreshed bank data. Confirm actual versus forecast periods.','Weekly amounts are placed at week end. Daily cash lows are unknown until you replace totals with dated payments.','Using this preview replaces the current cash draft; it does not add a second copy. Nothing is saved until you approve the forecast.']}
}
