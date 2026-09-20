export const JOB_STATUSES = ['quoting', 'quoted', 'active', 'complete', 'archived'] as const
export type JobStatus = typeof JOB_STATUSES[number]
export const isOpenJob = (status: string) => ['quoting', 'quoted', 'active'].includes(status)
