const STATUS_META: Record<string, { className: string; label: string }> = {
  pending: { className: 'bg-gray-100 text-gray-700', label: 'Pending' },
  detected: { className: 'bg-blue-100 text-blue-700', label: 'Detected' },
  confirmed: { className: 'bg-emerald-100 text-emerald-700', label: 'Confirmed' },
  completed: { className: 'bg-emerald-600 text-white', label: 'Completed' },
  expired: { className: 'bg-orange-100 text-orange-700', label: 'Expired' },
  cancelled: { className: 'bg-zinc-200 text-zinc-700', label: 'Cancelled' },
  underpaid: { className: 'bg-amber-100 text-amber-700', label: 'Underpaid' },
  overpaid: { className: 'bg-cyan-100 text-cyan-700', label: 'Overpaid' },
  callback_sent: { className: 'bg-violet-100 text-violet-700', label: 'Callback sent' },
  callback_failed: { className: 'bg-rose-100 text-rose-700', label: 'Callback failed' },
}

export default function StatusBadge({ status }: { status: string }) {
  const fallbackLabel = status.replaceAll('_', ' ')
  const meta = STATUS_META[status] ?? {
    className: 'bg-gray-100 text-gray-700',
    label: fallbackLabel.charAt(0).toUpperCase() + fallbackLabel.slice(1),
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.className}`}>
      {meta.label}
    </span>
  )
}
