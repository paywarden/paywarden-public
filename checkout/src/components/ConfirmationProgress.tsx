interface Props {
  confirmations: number | null
  required: number
}

export default function ConfirmationProgress({ confirmations, required }: Props) {
  const current = confirmations ?? 0
  const pct = Math.min(100, (current / required) * 100)

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm text-gray-600">
        <span>确认进度</span>
        <span>{current} / {required}</span>
      </div>
      <div className="w-full h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
