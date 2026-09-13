// Uses ONLY scripts/preview-profitability.cjs localhost fixtures. No external credentials.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  Excel = require('exceljs')
const origin = 'http://127.0.0.1:3221',
  job = '20000000-0000-4000-8000-000000000001',
  builder = '10000000-0000-4000-8000-000000000001',
  checks = []
const headers = {
  Authorization: 'Bearer local-fixture-service',
  'x-worka-builder-id': builder,
  'Content-Type': 'application/json',
}
async function request(path, body, method = 'POST') {
  const r = await fetch(origin + path, {
    headers,
    method: body ? method : 'GET',
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, data: await r.json() }
}
async function main() {
  const url = `/api/jobs/${job}/intelligence`
  let r = await fetch(origin + url)
  assert.equal(r.status, 401)
  checks.push('Anonymous API access denied')
  r = await fetch(origin + '/api/jobs/20000000-0000-4000-8000-000000000002/intelligence', {
    headers,
  })
  assert.equal(r.status, 404)
  checks.push('Cross-builder job access denied')
  let result = await request(url)
  assert.equal(result.status, 200)
  assert.equal(result.data.review.actualCost, 106100)
  assert.equal(result.data.review.trades[0].variance, 13900)
  checks.push('Actual costs and trade variance compose from existing ledgers')
  result = await request(url, { action: 'complete', confirmed: true })
  assert.equal(result.status, 400)
  checks.push('Completion requires captured original baseline')
  result = await request(url, { action: 'settings', originalContract: 116736, settings: { labourIncluded: false } })
  assert.equal(result.status, 400)
  assert.match(result.data.error, /GST basis/)
  checks.push('Project GST declaration cannot be omitted')
  result = await request(url, {
    action: 'settings',
    captureBaseline: true,
    originalContract: 116736,
    settings: {
      jobType: 'renovation',
      region: 'Sydney',
      complexity: 'architectural',
      constructionType: 'timber',
      size: 200,
      labourIncluded: false,
      sourceTaxBasis: 'exclusive',
      taxReconciled: true,
      targetMargin: null,
      contingency: 0,
      estimatedHours: { 2: 180 },
    },
  })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  checks.push('Builder-approved baseline is saved through atomic RPC')
  result = await request(url, { action: 'complete', confirmed: true })
  assert.equal(result.status, 400)
  assert.match(result.data.error, /trade mappings/)
  checks.push('Completed learning requires explicit mapping confirmation')
  result = await request(url, { action: 'complete', confirmed: true, mappingsConfirmed: true })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  result = await request(url)
  assert.equal(result.data.review.complete, true)
  assert.equal(result.data.review.trades[0].hoursVariance, 60)
  checks.push('Completed review records 180 estimated versus 240 actual framing hours')
  const workbook = new Excel.Workbook(),
    sheet = workbook.addWorksheet('Costs')
  sheet.addRow(['Description', 'Amount', 'Supplier', 'Date'])
  sheet.addRow(['Waste removal', 1100, 'Sample bins', '13/09/2026'])
  const bytes = await workbook.xlsx.writeBuffer()
  const form = new FormData()
  form.set(
    'file',
    new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    'sample-costs.xlsx',
  )
  r = await fetch(origin + `/api/jobs/${job}/cost-import`, {
    method: 'POST',
    headers: { Authorization: headers.Authorization, 'x-worka-builder-id': builder },
    body: form,
  })
  const upload = await r.json()
  assert.equal(r.status, 200, JSON.stringify(upload))
  assert.equal(upload.sheets[0].rows[1][1], '1100')
  checks.push('Real XLSX file upload parses into editable mapping preview')
  const body = {
    name: 'sample-costs.xlsx',
    rows: upload.sheets[0].rows.slice(1),
    mapping: {
      description: 0,
      amount: 1,
      supplier: 2,
      date: 3,
      invoice: -1,
      category: -1,
      costCode: -1,
      hours: -1,
      labourCost: -1,
      project: -1,
    },
    options: {
      taxBasis: 'inclusive',
      labourBasis: 'included',
      defaultDate: '2026-09-13',
      projectLabel: 'Sample renovation · 24 Banksia Street',
    },
    confirmed: true,
    labourReconciled: true,
  }
  result = await request(`/api/jobs/${job}/cost-import`, { ...body, confirmed: false }, 'PUT')
  assert.equal(result.status, 400)
  checks.push('Import requires explicit mapping confirmation')
  result = await request(`/api/jobs/${job}/cost-import`, body, 'PUT')
  assert.equal(result.status, 200, JSON.stringify(result.data))
  result = await request(url)
  assert.equal(result.data.review.actualCost, 107100)
  assert.equal(result.data.review.complete, false)
  checks.push('Approved XLSX import converts 1100 incl GST to 1000 ex GST and refreshes review')
  result = await request(`/api/jobs/${job}/cost-import`, body, 'PUT')
  assert.equal(result.status, 400)
  assert.match(result.data.error, /already been imported/)
  checks.push('Repeated import is rejected with an actionable message')
  result = await request(
    `/api/jobs/${job}/cost-import`,
    { ...body, rows: [['Bad invoice', 'not a number', 'Sample', '13/09/2026']] },
    'PUT',
  )
  assert.equal(result.status, 400)
  checks.push('Invalid financial data rejected before saving')
  result = await request(`/api/jobs/${job}/correspondence`, {
    text: 'Change windows to black aluminium',
  })
  assert.equal(result.status, 400)
  assert.match(result.data.error, /AI analysis is unavailable/)
  checks.push('Unavailable AI fails honestly without invented analysis or approvals')
  const output = {
    mode: 'Real Next.js routes and XLSX parser against local synthetic HTTP fixtures; SQL atomicity/RLS tested separately',
    passed: checks.length,
    checks,
  }
  fs.writeFileSync('tuesday-api-tests.json', JSON.stringify(output, null, 2))
  console.log(JSON.stringify(output, null, 2))
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
