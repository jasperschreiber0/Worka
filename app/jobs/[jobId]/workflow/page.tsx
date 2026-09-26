import JobWorkflow from '@/components/jobs/JobWorkflow'
export default function Page({params}:{params:{jobId:string}}){return <JobWorkflow jobId={params.jobId}/>}
