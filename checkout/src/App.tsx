import { getCheckoutState } from './payment-state'
import { useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import './index.css'
import type { CheckoutStatus } from './types'
import { useOrderStatus } from './hooks/useOrderStatus'
import CopyButton from './components/CopyButton'
import CountdownTimer from './components/CountdownTimer'
import ConfirmationProgress from './components/ConfirmationProgress'

// Derive orderId from pathname: /checkout/:order_id
const orderId = window.location.pathname.split('/').filter(Boolean).pop() ?? ''

const MIN_CONFIRMATIONS = 19

function Header() {
  return (
    <div className="border-b border-gray-100 pb-4 mb-6 text-center">
      <h1 className="text-base font-semibold text-gray-800">PayWarden</h1>
    </div>
  )
}

function Footer({ currency, network }: { currency: string; network: string }) {
  return (
    <div className="border-t border-gray-100 pt-4 mt-6 text-center text-xs text-gray-400">
      {network} · {currency} · 确认数 {MIN_CONFIRMATIONS} 个
    </div>
  )
}

function PendingView({ status, onExpired }: { status: CheckoutStatus; onExpired: () => void }) {
  const payable = status.amount_payable ?? status.amount_expected
  const tronUri = `tron:${status.address}?amount=${payable}`

  return (
    <div className="space-y-5">
      <p className="text-center text-sm text-gray-600">请向以下地址转入 USDT（TRC20）</p>

      <div className="flex justify-center">
        <a href={tronUri} className="block hover:opacity-90 transition-opacity" title="在 TronLink 中打开">
          <QRCodeSVG value={tronUri} size={180} fgColor="#111827" />
        </a>
      </div>

      <div className="bg-gray-50 rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">金额</span>
          <span className="text-lg font-bold text-gray-900">{payable} USDT</span>
        </div>
        <div>
          <span className="text-sm text-gray-500 block mb-1">收款地址</span>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-700 break-all flex-1">{status.address}</code>
            <CopyButton text={status.address} />
          </div>
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1 text-center">订单有效期</p>
        <CountdownTimer expiresAt={status.expires_at} onExpired={onExpired} />
      </div>
    </div>
  )
}

function DetectedView({ status }: { status: CheckoutStatus }) {
  const scanUrl = `https://nile.tronscan.org/#/transaction/${status.tx_hash}`

  return (
    <div className="space-y-5 text-center">
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
      </div>

      <div>
        <p className="font-semibold text-gray-900">已检测到您的支付</p>
        <p className="text-sm text-gray-500 mt-1">正在等待区块链确认...</p>
      </div>

      <div className="bg-gray-50 rounded-lg p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">已收到</span>
          <span className="font-medium">{Number(status.amount_received).toFixed(6)} USDT</span>
        </div>
        <ConfirmationProgress confirmations={status.confirmations} required={MIN_CONFIRMATIONS} />
      </div>

      {status.tx_hash && (
        <a
          href={scanUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline block"
        >
          查看区块浏览器 ↗
        </a>
      )}

      <p className="text-xs text-gray-400">请勿关闭此页面</p>
    </div>
  )
}

function SuccessView({ status }: { status: CheckoutStatus }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      window.parent.postMessage(
        { type: 'checkout.completed', orderId, payload: { amountReceived: status.amount_received }, timestamp: Date.now() },
        '*',
      )
    }, 3000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="space-y-5 text-center">
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
          <span className="text-4xl">✓</span>
        </div>
      </div>
      <div>
        <p className="text-xl font-semibold text-green-700">支付成功！</p>
        <p className="text-sm text-gray-500 mt-1">{Number(status.amount_received).toFixed(6)} USDT</p>
      </div>
      <p className="text-xs text-gray-400">正在返回商户页面...</p>
    </div>
  )
}

function OverpaidView({ status }: { status: CheckoutStatus }) {
  const diff = (Number(status.amount_received) - Number(status.amount_expected)).toFixed(6)
  return (
    <div className="space-y-4 text-center">
      <div className="text-4xl">⚠️</div>
      <p className="font-semibold text-gray-900">已检测到超额支付</p>
      <div className="bg-orange-50 rounded-lg p-4 text-sm space-y-1">
        <div className="flex justify-between"><span className="text-gray-500">预期</span><span>{Number(status.amount_expected).toFixed(6)} USDT</span></div>
        <div className="flex justify-between"><span className="text-gray-500">实收</span><span>{Number(status.amount_received).toFixed(6)} USDT</span></div>
        <div className="flex justify-between text-orange-700 font-medium"><span>超额</span><span>+{diff} USDT</span></div>
      </div>
      <p className="text-xs text-gray-500">订单已标记为已支付，超额部分请联系商户处理。</p>
    </div>
  )
}

function UnderpaidView({ status }: { status: CheckoutStatus }) {
  const diff = (Number(status.amount_expected) - Number(status.amount_received)).toFixed(6)
  return (
    <div className="space-y-4 text-center">
      <div className="text-4xl">⚠️</div>
      <p className="font-semibold text-gray-900">收到的金额不足</p>
      <div className="bg-yellow-50 rounded-lg p-4 text-sm space-y-1">
        <div className="flex justify-between"><span className="text-gray-500">预期</span><span>{Number(status.amount_expected).toFixed(6)} USDT</span></div>
        <div className="flex justify-between"><span className="text-gray-500">实收</span><span>{Number(status.amount_received).toFixed(6)} USDT</span></div>
        <div className="flex justify-between text-yellow-700 font-medium"><span>差额</span><span>-{diff} USDT</span></div>
      </div>
      <p className="text-xs text-gray-500">如需补差额，请联系商户。订单已记录实收金额。</p>
    </div>
  )
}

function ExpiredView() {
  return (
    <div className="space-y-4 text-center">
      <div className="text-4xl">⏰</div>
      <p className="font-semibold text-gray-900">订单已过期</p>
      <p className="text-sm text-gray-500">该支付请求已超时（30 分钟）。如需继续支付，请返回商户页面重新发起请求。</p>
      <button
        onClick={() => window.parent.postMessage({ type: 'checkout.expired', orderId, timestamp: Date.now() }, '*')}
        className="px-6 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700"
      >
        重新下单
      </button>
    </div>
  )
}

function StatusView({ status, onExpired }: { status: CheckoutStatus; onExpired: () => void }) {
  switch (getCheckoutState(status)) {
    case 'pending':
      return <PendingView status={status} onExpired={onExpired} />
    case 'detected':
      return <DetectedView status={status} />
    case 'confirmed':
    case 'completed':
    case 'callback_sent':
      return <SuccessView status={status} />
    case 'overpaid':
      return <OverpaidView status={status} />
    case 'underpaid':
      return <UnderpaidView status={status} />
    case 'expired':
      return <ExpiredView />
    default:
      return <p className="text-center text-gray-500 text-sm">状态：{status.status}</p>
  }
}

export default function App() {
  const { status, error, refetch } = useOrderStatus(orderId)

  if (!orderId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-500 text-sm">缺少订单 ID</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-sm p-6">
        <Header />

        {error && !status && (
          <div className="text-center space-y-3">
            <p className="text-red-500 text-sm">无法加载订单信息</p>
            <button onClick={refetch} className="text-xs text-blue-600 hover:underline">重试</button>
          </div>
        )}

        {!status && !error && (
          <div className="flex justify-center py-8">
            <div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-blue-500 animate-spin" />
          </div>
        )}

        {status && (
          <>
            <StatusView status={status} onExpired={refetch} />
            <Footer currency={status.currency} network={status.network} />
          </>
        )}
      </div>
    </div>
  )
}
