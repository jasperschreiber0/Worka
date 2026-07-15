'use client'
import type { ChangeEvent, FormEvent, KeyboardEvent, RefObject } from 'react'

export interface ChatInputProps {
  value: string
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onSubmit: (e: FormEvent) => void
  inputRef: RefObject<HTMLTextAreaElement>
  loading: boolean
  isListening: boolean
  onToggleVoice: () => void
  placeholder?: string
}

// The app's primary navigation surface — mic + free-text input + send.
// Extracted from ChatInterface so it's a standalone, reusable component
// (matching the brief's named component list) without changing behavior.
export default function ChatInput({
  value,
  onChange,
  onKeyDown,
  onSubmit,
  inputRef,
  loading,
  isListening,
  onToggleVoice,
  placeholder = 'What needs doing?',
}: ChatInputProps) {
  return (
    <div>
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <label htmlFor="chat-input" className="sr-only">
          Type a message
        </label>
        {/* Mic button */}
        <button
          type="button"
          onClick={onToggleVoice}
          disabled={loading}
          aria-label={isListening ? 'Stop recording' : 'Start voice input'}
          className={`flex-shrink-0 w-10 h-10 rounded-[6px] flex items-center justify-center transition-colors disabled:opacity-40${isListening ? ' animate-pulse' : ''}`}
          style={isListening ? {
            backgroundColor: 'rgba(244,67,54,0.15)',
            color: 'var(--status-red)',
          } : {
            backgroundColor: 'var(--bg-elevated)',
            border: '0.5px solid var(--bg-border)',
            color: 'var(--text-tertiary)',
          }}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
          </svg>
        </button>
        <textarea
          ref={inputRef}
          id="chat-input"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={isListening ? 'Listening…' : placeholder}
          rows={1}
          disabled={loading}
          className="flex-1 resize-none rounded-[6px] px-3 py-2 text-[13px] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed overflow-hidden"
          style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', color: 'var(--text-primary)', outlineColor: 'var(--orange-primary)', minHeight: '40px', maxHeight: '120px' }}
        />
        <button
          type="submit"
          disabled={loading || !value.trim()}
          className="flex-shrink-0 text-white text-[12px] font-semibold px-3 py-1.5 rounded-[4px] min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={{ backgroundColor: 'var(--orange-primary)' }}
          aria-label="Send message"
        >
          Send
        </button>
      </form>
      <p className="mt-1.5 text-xs hidden sm:block" style={{ color: 'var(--text-tertiary)' }}>
        Press <kbd className="font-mono text-xs rounded px-1" style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>Enter</kbd> to send
        &nbsp;&middot;&nbsp;
        <kbd className="font-mono text-xs rounded px-1" style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>Shift+Enter</kbd> for new line
      </p>
    </div>
  )
}
