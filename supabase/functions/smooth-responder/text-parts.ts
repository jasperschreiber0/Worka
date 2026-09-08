export function splitTextParts(text: string, size = 12000, overlap = 300): string[] {
  if (size <= overlap || overlap < 0) throw new Error('Invalid part bounds')
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length) {
      const line = text.lastIndexOf('\n', end)
      if (line > start + size / 2) end = line + 1
    }
    parts.push(text.slice(start,end))
    if (end === text.length) break
    start = end - overlap
  }
  return parts
}
export function combinePartResults(rows: Array<{part_index:number; payload:any}>, total: number): any | null {
  if (rows.length !== total || new Set(rows.map(r=>r.part_index)).size !== total || rows.some(r=>r.part_index<0 || r.part_index>=total)) return null
  const ordered=[...rows].sort((a,b)=>a.part_index-b.part_index)
  const facts=new Map<string,unknown>()
  for(const row of ordered) {
    if (!Array.isArray(row.payload.facts) || !Array.isArray(row.payload.documents) || row.payload.documents.length!==1) throw new Error('Incomplete part result')
    for(const fact of row.payload.facts) facts.set(JSON.stringify([fact.category,fact.key,fact.value]),fact)
  }
  return {documents:[{...ordered[0].payload.documents[0],page_count:null,notes:(ordered[0].payload.documents[0].notes??'')+' Analysed in '+total+' text parts; original PDF retained.'}],facts:[...facts.values()]}
}
