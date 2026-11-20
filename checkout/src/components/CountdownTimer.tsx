import { useEffect, useState } from 'react'

interface Props {
  expiresAt: string
  onExpired: () => void
}

export default function CountdownTimer({ expiresAt, onExpired }: Props) {
  const getRemaining = () => Math.max(0, new Date(expiresAt).getTime() - Date.now())
  const [remaining, setRemaining] = useState(getRemaining)

  useEffect(() => {
    if (remaining <= 0) { onExpired(); return }

    const id = setInterval(() => {
      const r = getRemaining()
      setRemaining(r)
      if (r <= 0) { clearInterval(id); onExpired() }
    }, 1000)

    return () => clearInterval(id)
  }, [expiresAt])

  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  const progress = remaining / (30 * 60_000)
  const isUrgent = remaining < 60_000

  return (
    <div className="space-y-2">
      <div className={`text-2xl font-mono font-bold ${isUrgent ? 'text-red-500' : 'text-gray-700'}`}>
        {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
      </div>
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${isUrgent ? 'bg-red-500' : 'bg-blue-500'}`}
          style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
        />
      </div>
    </div>
  )
}
