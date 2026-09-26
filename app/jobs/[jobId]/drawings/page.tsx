import JobDrawings from '@/components/jobs/JobDrawings'
export default function Page({params}:{params:{jobId:string}}){return <JobDrawings jobId={params.jobId}/>}
