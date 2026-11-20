import { useState } from 'react'

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fallback */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}

export default function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const handle = async () => {
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <button
      onClick={handle}
      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 transition-colors min-h-[44px]"
    >
      {copied ? (
        <span className="text-green-600 font-medium">✓ 已复制</span>
      ) : (
        <span className="text-gray-600">{label}</span>
      )}
    </button>
  )
}
