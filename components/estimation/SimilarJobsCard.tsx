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

function similarityBadgeStyle(score: number): React.CSSProperties {
  if (score >= 90) return { background: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' }
  if (score >= 80) return { background: 'rgba(255,107,43,0.12)', color: 'var(--orange-primary)' }
  if (score >= 70) return { background: 'rgba(33,150,243,0.1)', color: 'var(--status-blue)' }
  return { background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' }
}

function varianceStyle(pct: number): React.CSSProperties {
  if (Math.abs(pct) < 5) return { color: 'var(--status-green)' }
  if (pct > 0) return { color: 'var(--status-amber)' }
  return { color: 'var(--text-tertiary)' }
}

export default function SimilarJobsCard({ similarProjects, totalInMemory }: SimilarJobsCardProps) {
  const [expanded, setExpanded] = useState(false)

  if (similarProjects.length === 0) {
    return (
      <div
        className="rounded-lg px-4 py-3"
        style={{ border: '0.5px solid var(--bg-border)', background: 'var(--bg-elevated)' }}
      >
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          No similar historical projects found yet. As you complete more jobs, WorkA will use them to improve future estimates.
        </p>
      </div>
    )
  }

  const shown = expanded ? similarProjects : similarProjects.slice(0, 3)

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: '0.5px solid var(--bg-border)', background: 'var(--bg-elevated)' }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 border-b"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--bg-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(33,150,243,0.1)' }}
          >
            <svg
              className="w-3.5 h-3.5"
              style={{ color: 'var(--status-blue)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Informed by {similarProjects.length} similar project{similarProjects.length !== 1 ? 's' : ''}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              From {totalInMemory} job{totalInMemory !== 1 ? 's' : ''} in estimation memory
            </p>
          </div>
        </div>
      </div>

      {/* Project list */}
      <div className="divide-y" style={{ borderColor: 'var(--bg-border)' }}>
        {shown.map((project) => {
          const variance = project.quoted_cost && project.final_cost
            ? Math.round((project.final_cost - project.quoted_cost) / project.quoted_cost * 100)
            : null
          return (
            <div
              key={project.id}
              className="px-4 py-3"
              style={{ background: 'var(--bg-surface)' }}
            >
              <div className="flex items-start gap-3">
                {/* Similarity badge */}
                <span
                  className="flex-shrink-0 text-xs font-bold px-2 py-0.5 rounded-full mt-0.5"
                  style={similarityBadgeStyle(project.similarity_score)}
                >
                  {project.similarity_score}%
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-snug" style={{ color: 'var(--text-secondary)' }}>
                    {project.project_summary}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                    {project.floor_area_m2 && (
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {project.floor_area_m2}sqm
                      </span>
                    )}
                    {project.suburb && project.region && (
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {project.suburb}, {project.region}
                      </span>
                    )}
                    {project.quoted_cost && (
                      <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        Quoted {formatAUD(project.quoted_cost)}
                      </span>
                    )}
                    {project.final_cost && (
                      <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        Final {formatAUD(project.final_cost)}
                      </span>
                    )}
                    {variance !== null && (
                      <span className="text-xs font-medium" style={varianceStyle(variance)}>
                        {variance > 0 ? '+' : ''}{variance}% variance
                      </span>
                    )}
                  </div>
                  {/* Match reasons */}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {project.similarity_reasons.map((r, i) => (
                      <span
                        key={i}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: 'rgba(33,150,243,0.08)',
                          color: 'var(--status-blue)',
                          border: '0.5px solid rgba(33,150,243,0.2)',
                        }}
                      >
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
        <div
          className="px-4 py-2.5 text-center border-t"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--bg-border)' }}
        >
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-medium"
            style={{ color: 'var(--status-blue)' }}
          >
            {expanded ? '↑ Show less' : `Show ${similarProjects.length - 3} more similar projects`}
          </button>
        </div>
      )}
    </div>
  )
}
