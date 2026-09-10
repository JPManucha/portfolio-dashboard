import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const corsHeaders = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: new Headers(corsHeaders) })
  const url = new URL(req.url)
  const token = url.searchParams.get('token') || url.searchParams.get('k')
  const expectedToken = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || ''
  if (!token || token !== expectedToken) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: new Headers({ 'content-type': 'application/json', ...corsHeaders }) })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const supabase = createClient(supabaseUrl, supabaseKey)

  const [holdingsRes, txsRes, alertsRes] = await Promise.all([
    supabase.from('holdings_current').select('*'),
    supabase.from('transactions').select('*').order('fecha', { ascending: true }),
    supabase.from('concentration_alerts').select('*').order('valor_usd', { ascending: false }),
  ])

  const holdings = holdingsRes.data || []
  const allTxs = txsRes.data || []
  const alerts = alertsRes.data || []

  let totalValor = 0, totalInvertido = 0, totalPnl = 0, liquidez = 0
  for (const h of holdings) {
    const v = parseFloat(h.valor_usd) || 0
    const i = parseFloat(h.invertido_usd) || 0
    const p = parseFloat(h.pnl_usd) || 0
    totalValor += v; totalInvertido += i; totalPnl += p
    if ((h.tipo === 'CASH' && h.activo === 'USD') || (h.tipo === 'CRYPTO' && h.activo === 'USDC')) liquidez += v
  }

  let totalRealizado = 0
  for (const h of holdings) totalRealizado += parseFloat(h.pnl_realizado_usd) || 0

  const invertidoProductivo = totalInvertido - liquidez
  const retornoTotal = invertidoProductivo > 0 ? ((totalPnl + totalRealizado) / invertidoProductivo) * 100 : 0

  // --- WEEKLY TIMELINE with market prices ---
  const firstDate = allTxs.length > 0 ? allTxs[0].fecha : new Date().toISOString().split('T')[0]
  const startTs = Math.floor(new Date(firstDate).getTime() / 1000)
  const endTs = Math.floor(Date.now() / 1000)

  const YT: Record<string, string> = {
    'BRK.B': 'BRK-B', 'GLD': 'GLD', 'SPY': 'SPY', 'UNH': 'UNH', 'NVDA': 'NVDA',
    'GOOGL': 'GOOGL', 'AAPL': 'AAPL', 'BABA': 'BABA', 'PBR': 'PBR', 'MELI': 'MELI',
    'BTC': 'BTC-USD', 'ETH': 'ETH-USD',
  }
  const CEDEAR = new Set(['BRK.B', 'GLD', 'SPY', 'UNH', 'NVDA'])

  const tickers = new Set<string>()
  for (const t of allTxs) { const yt = YT[t.activo]; if (yt) tickers.add(yt) }
  const allTickers = [...tickers, 'SPY', 'QQQ']

  async function fetchWeekly(t: string): Promise<[string, Map<string, number>]> {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 15_000)
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?period1=${startTs}&period2=${endTs}&interval=1wk`, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(timer)
      const json = await res.json()
      const ts: number[] = json?.chart?.result?.[0]?.timestamp || []
      const q: number[] = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []
      const m = new Map<string, number>()
      for (let i = 0; i < ts.length; i++) if (q[i] && q[i] > 0) m.set(new Date(ts[i] * 1000).toISOString().split('T')[0], q[i])
      return [t, m]
    } catch { return [t, new Map()] }
  }

  const results = await Promise.all(allTickers.map(t => fetchWeekly(t)))
  const priceCache = new Map(results)

  function priceAt(ticker: string, date: string): number {
    const pm = priceCache.get(ticker)
    if (!pm) return 0
    let best = 0
    for (const [d, p] of pm) if (d <= date) best = p
    return best
  }

  const cedearRatios = new Map<string, number>()
  for (const h of holdings) {
    if (h.tipo === 'CEDEAR' && h.ratio && parseFloat(h.ratio) > 0 && !cedearRatios.has(h.activo)) {
      cedearRatios.set(h.activo, parseFloat(h.ratio))
    }
  }

  const transferKeys = new Set<string>()
  for (const t of allTxs) {
    if (t.operacion === 'Venta') {
      const match = allTxs.find(t2 => t2.operacion === 'Ingreso' && t2.fecha === t.fecha && t2.activo === t.activo && t2.cantidad === t.cantidad && t2.broker_id !== t.broker_id)
      if (match) {
        transferKeys.add(`${t.fecha}_${t.activo}_Venta`)
        transferKeys.add(`${match.fecha}_${match.activo}_Ingreso`)
      }
    }
  }

  const spyWeekly = priceCache.get('SPY') || new Map()
  const qqqWeekly = priceCache.get('QQQ') || new Map()
  const weeklyDates = [...spyWeekly.keys()].filter(d => d >= firstDate).sort()
  const dates = weeklyDates.length > 0 ? weeklyDates : [new Date().toISOString().split('T')[0]]

  const weeklyPoints: { date: string; invested: number; value: number; cumInvested: number }[] = []
  const spyDCA: { date: string; value: number }[] = []
  const qqqDCA: { date: string; value: number }[] = []

  for (const weekDate of dates) {
    const localSim = new Map<string, { cant: number; cost: number }>()
    let ci = 0
    let dcaSpySh = 0, dcaQqqSh = 0

    for (const t of allTxs) {
      if (t.fecha > weekDate) break
      const c = parseFloat(t.cantidad) || 0
      const tot = parseFloat(t.total_usd) || 0
      const key = `${t.activo}_${t.broker_id}`
      const txKey = `${t.fecha}_${t.activo}_${t.operacion}`
      const isTransfer = transferKeys.has(txKey)
      const sp = priceAt('SPY', t.fecha) || priceAt('SPY', weekDate)
      const qp = priceAt('QQQ', t.fecha) || priceAt('QQQ', weekDate)

      if (t.operacion === 'Compra') {
        const prev = localSim.get(key) || { cant: 0, cost: 0 }
        localSim.set(key, { cant: prev.cant + c, cost: prev.cost + tot })
        ci += tot
        if (sp > 0) dcaSpySh += tot / sp
        if (qp > 0) dcaQqqSh += tot / qp
      } else if (t.operacion === 'Venta') {
        const prev = localSim.get(key)
        if (prev && prev.cant > 0) {
          const r = Math.min(c / prev.cant, 1)
          prev.cost -= prev.cost * r
          localSim.set(key, { cant: Math.max(0, prev.cant - c), cost: prev.cost })
        }
      } else if (t.operacion === 'Ingreso') {
        if (!isTransfer) {
          ci += tot
          if (sp > 0) dcaSpySh += tot / sp
          if (qp > 0) dcaQqqSh += tot / qp
        }
      } else if (t.operacion === 'Retiro') {
        ci = Math.max(0, ci - tot)
      }
    }

    let marketVal = 0
    for (const [k, st] of localSim) {
      const activo = k.split('_')[0]
      let p = 0
      const yt = YT[activo]
      if (yt) {
        const raw = priceAt(yt, weekDate)
        if (raw > 0) {
          const ratio = cedearRatios.get(activo)
          p = ratio ? raw / ratio : raw
        }
      }
      if (p === 0 && st.cant > 0) p = st.cost / st.cant
      marketVal += st.cant * p
    }

    weeklyPoints.push({ date: weekDate, invested: marketVal, value: marketVal, cumInvested: ci })
    spyDCA.push({ date: weekDate, value: dcaSpySh * (priceAt('SPY', weekDate) || 1) })
    qqqDCA.push({ date: weekDate, value: dcaQqqSh * (priceAt('QQQ', weekDate) || 1) })
  }

  if (weeklyPoints.length === 0) weeklyPoints.push({ date: new Date().toISOString().split('T')[0], invested: totalValor, value: totalValor, cumInvested: 0 })

  const pnlAgg = new Map<string, { invertido: number; valor: number; pnl: number }>()
  for (const h of holdings) {
    if (h.activo === 'USD' || h.activo === 'USDC') continue
    if (parseFloat(h.cantidad) <= 0) continue
    const prev = pnlAgg.get(h.activo) || { invertido: 0, valor: 0, pnl: 0 }
    prev.invertido += parseFloat(h.invertido_usd) || 0; prev.valor += parseFloat(h.valor_usd) || 0; prev.pnl += parseFloat(h.pnl_usd) || 0
    pnlAgg.set(h.activo, prev)
  }

  const data = {
    kpis: { totalValor, invertidoProductivo, liquidez, totalPnl, totalRealizado, retornoTotal },
    pie: holdings.filter((h: any) => h.activo !== 'USD' && h.activo !== 'USDC' && parseFloat(h.cantidad) > 0).map((h: any) => ({ label: `${h.activo} (${h.broker})`, ticker: h.activo, value: parseFloat(h.valor_usd) || 0, pnl: parseFloat(h.pnl_usd) || 0, pnlPct: parseFloat(h.pnl_pct) || 0 })),
    pnlBars: Array.from(pnlAgg.entries()).sort((a, b) => b[1].pnl - a[1].pnl).map(([activo, d]) => ({ activo, ...d })),
    timeline: { points: weeklyPoints, spyDCA, qqqDCA },
    alerts: alerts.filter((a: any) => a.activo !== 'USD' && a.activo !== 'USDC').map((a: any) => ({ activo: a.activo, broker: a.broker, pct: a.pct_portfolio, valor: parseFloat(a.valor_usd), level: a.alert_level })),
    allTransactions: allTxs.slice().reverse().map((t: any) => ({ fecha: t.fecha, operacion: t.operacion, activo: t.activo, cantidad: parseFloat(t.cantidad), total: parseFloat(t.total_usd) })),
    recentTxs: allTxs.slice(-10).reverse().map((t: any) => ({ fecha: t.fecha, operacion: t.operacion, activo: t.activo, cantidad: parseFloat(t.cantidad), total: parseFloat(t.total_usd) })),
    holdings: holdings.filter((h: any) => h.cantidad > 0).map((h: any) => ({ activo: h.activo, broker: h.broker, tipo: h.tipo, cantidad: parseFloat(h.cantidad), precio: parseFloat(h.precio_usd || 0), valor: parseFloat(h.valor_usd || 0), invertido: parseFloat(h.invertido_usd || 0), pnlPct: parseFloat(h.pnl_pct || 0), ratio: h.ratio })),
  }

  return new Response(JSON.stringify(data), { status: 200, headers: new Headers({ 'content-type': 'application/json', ...corsHeaders }) })
})
