'use client'

import { useState } from 'react'
import type { SimilarProject } from '@/lib/types/estimation.types'

interface SimilarJobsCardProps {
  similarProjects: SimilarProject[]
  totalInMemory: number
}

function formatAUD(n: number): string {
  return `$${n.toLocaleString('en-AU')}`
}

function similarityColor(score: number): string {
  if (score >= 90) return 'bg-green-100 text-green-800'
  if (score >= 80) return 'bg-brand-100 text-brand-800'
  if (score >= 70) return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-600'
}

function varianceColor(pct: number): string {
  if (Math.abs(pct) < 5) return 'text-green-600'
  if (pct > 0) return 'text-amber-600'
  return 'text-slate-500'
}

export default function SimilarJobsCard({ similarProjects, totalInMemory }: SimilarJobsCardProps) {
  const [expanded, setExpanded] = useState(false)

  if (similarProjects.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs text-slate-500">
          No similar historical projects found yet. As you complete more jobs, WorkA will use them to improve future estimates.
        </p>
      </div>
    )
  }

  const shown = expanded ? similarProjects : similarProjects.slice(0, 3)

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-blue-100">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-800">
              Informed by {similarProjects.length} similar project{similarProjects.length !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-slate-500">
              From {totalInMemory} job{totalInMemory !== 1 ? 's' : ''} in estimation memory
            </p>
          </div>
        </div>
      </div>

      {/* Project list */}
      <div className="divide-y divide-blue-100">
        {shown.map((project) => {
          const variance = project.quoted_cost && project.final_cost
            ? Math.round((project.final_cost - project.quoted_cost) / project.quoted_cost * 100)
            : null
          return (
            <div key={project.id} className="px-4 py-3 bg-white">
              <div className="flex items-start gap-3">
                {/* Similarity badge */}
                <span className={`flex-shrink-0 text-xs font-bold px-2 py-0.5 rounded-full mt-0.5 ${similarityColor(project.similarity_score)}`}>
                  {project.similarity_score}%
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 leading-snug">{project.project_summary}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                    {project.floor_area_m2 && (
                      <span className="text-xs text-slate-500">{project.floor_area_m2}sqm</span>
                    )}
                    {project.suburb && project.region && (
                      <span className="text-xs text-slate-500">{project.suburb}, {project.region}</span>
                    )}
                    {project.quoted_cost && (
                      <span className="text-xs font-medium text-slate-600">Quoted {formatAUD(project.quoted_cost)}</span>
                    )}
                    {project.final_cost && (
                      <span className="text-xs font-medium text-slate-600">Final {formatAUD(project.final_cost)}</span>
                    )}
                    {variance !== null && (
                      <span className={`text-xs font-medium ${varianceColor(variance)}`}>
                        {variance > 0 ? '+' : ''}{variance}% variance
                      </span>
                    )}
                  </div>
                  {/* Match reasons */}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {project.similarity_reasons.map((r, i) => (
                      <span key={i} className="text-[10px] bg-blue-50 text-blue-600 border border-blue-100 px-1.5 py-0.5 rounded">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Show more */}
      {similarProjects.length > 3 && (
        <div className="px-4 py-2.5 bg-blue-50 text-center border-t border-blue-100">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            {expanded ? '↑ Show less' : `Show ${similarProjects.length - 3} more similar projects`}
          </button>
        </div>
      )}
    </div>
  )
}
