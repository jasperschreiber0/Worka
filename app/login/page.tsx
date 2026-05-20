import { Suspense } from 'react'
import LoginForm from './LoginForm'

export const metadata = {
  title: 'Sign in — WorkA',
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <LoginForm />
    </Suspense>
  )
}
