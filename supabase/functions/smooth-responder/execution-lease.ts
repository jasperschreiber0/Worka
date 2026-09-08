interface LeaseClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

/** Claim at the worker boundary: dispatchers cannot accidentally start two runs. */
export async function withExecutionLease(
  client: LeaseClient,
  jobId: string,
  fileId: string,
  builderId: string,
  work: () => Promise<void>,
): Promise<boolean> {
  const token = crypto.randomUUID()
  const { data, error } = await client.rpc('claim_estimation_execution', {
    p_job_id: jobId, p_file_id: fileId, p_builder_id: builderId, p_token: token,
  })
  if (error) throw new Error('Could not establish estimation execution ownership')
  if (data !== true) return false
  try {
    await work()
    return true
  } finally {
    const released = await client.rpc('release_estimation_execution', { p_job_id: jobId, p_token: token })
    if (released.error) console.error('Estimation execution lease release failed; expiry will recover it')
  }
}
