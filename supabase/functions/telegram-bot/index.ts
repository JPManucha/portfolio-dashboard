import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    text?: string
    from?: { id: number }
  }
}

interface ParsedCommand {
  type: 'compra' | 'vende' | 'swap' | 'resumen' | 'estado' | 'activo' | 'historial' | 'concentracion' | 'pausar' | 'reanudar' | 'ingreso' | 'retiro' | 'alerta' | 'alertas' | 'borralerta' | 'futuro' | 'futuros'
  cantidad?: number
  activo?: string
  precio?: number
  broker?: string
  tipo?: string
  ratio?: number
  pin?: string
  cantidad2?: number
  activo2?: string
  direction?: string
  precio_entrada?: number
  precio_salida?: number
  pnl_usd?: number
  direccion?: string
}

const MAX_CANTIDAD = 1_000_000
const TICKER_RE = /^[A-Z0-9]{1,10}(\.[A-Z]{1,5})?$/
const RATE_LIMIT_WINDOW = 60_000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map<string, number[]>()

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const timestamps = rateLimitMap.get(ip) || []
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW)
  recent.push(now)
  rateLimitMap.set(ip, recent)
  return recent.length <= RATE_LIMIT_MAX
}

function getCedearRatio(activo: string, config: Record<string, string>): number | null {
  const key = activo.replace('.', '')
  const stored = config[`cedear_ratio_${key}`]
  if (stored) {
    const n = parseFloat(stored)
    if (!isNaN(n) && n > 0) return n
  }
  return null
}

async function fetchCedearRatio(activo: string): Promise<number | null> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8_000)
    const res = await Promise.all([
      fetch('https://data912.com/live/arg_cedears', { signal: ac.signal }),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${activo}`, { signal: ac.signal }),
      fetch('https://dolarapi.com/v1/dolares', { signal: ac.signal }),
    ])
    clearTimeout(timer)
    const [cedearsRes, yahooRes, dolaresRes] = res
    const cedears = await cedearsRes.json() as Array<{ symbol: string; c: number }>
    const cedear = cedears.find(c => c.symbol === activo)
    if (!cedear?.c || cedear.c <= 0) return null

    const yahooData = await yahooRes.json() as any
    const underlyingPrice = yahooData?.chart?.result?.[0]?.meta?.regularMarketPrice
    if (!underlyingPrice || underlyingPrice <= 0) return null

    const dolares = await dolaresRes.json() as Array<{ casa: string; venta: number }>
    const ccl = dolares.find(d => d.casa === 'contadoconliqui')
    if (!ccl?.venta || ccl.venta <= 0) return null

    const ratio = Math.round(underlyingPrice * ccl.venta / cedear.c)
    if (ratio <= 0) return null
    return ratio
  } catch {
    return null
  }
}

const YT_MAP: Record<string, string> = {
  'BRK.B': 'BRK-B', 'GLD': 'GLD', 'SPY': 'SPY', 'UNH': 'UNH', 'NVDA': 'NVDA',
  'GOOGL': 'GOOGL', 'AAPL': 'AAPL', 'BABA': 'BABA', 'PBR': 'PBR', 'MELI': 'MELI',
  'BMA': 'BMA', 'YPF': 'YPF',
  'BTC': 'BTC-USD', 'ETH': 'ETH-USD',
}

async function fetchYahooPrice(ticker: string): Promise<number | null> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8_000)
    const yt = YT_MAP[ticker] || ticker
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yt}?interval=1d&range=5d`,
      { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    clearTimeout(timer)
    const json = await res.json()
    const quotes: number[] = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []
    return quotes.filter(q => q > 0).pop() || null
  } catch (e) {
    console.error(`fetchYahooPrice failed for ${ticker}:`, e instanceof Error ? e.message : e)
    return null
  }
}

async function fetchLivePrices(holdings: any[]): Promise<Map<string, number>> {
  const uniqueTickers = [...new Set(holdings.map((h: any) => h.activo))]
  const entries = await Promise.all(
    uniqueTickers.map(async (t) => {
      if (t === 'USD' || t === 'USDC') return [t, 1] as const
      const price = await fetchYahooPrice(t)
      return [t, price ?? 0] as const
    })
  )
  return new Map(entries)
}

async function savePricesToHistory(supabase: any, cache: Map<string, number>): Promise<void> {
  const today = new Date().toISOString().split('T')[0]
  for (const [ticker, price] of cache) {
    if (ticker === 'USD' || ticker === 'USDC' || !price || price <= 0) continue
    await supabase
      .from('price_history')
      .upsert(
        { activo: ticker, precio_usd: price, fuente: 'yahoo', fecha: today },
        { onConflict: 'activo, fecha' }
      )
  }
}

function getLivePrice(ticker: string, tipo: string, ratio: number | null | undefined, cache: Map<string, number>): number {
  if (ticker === 'USD' || ticker === 'USDC') return 1
  const raw = cache.get(ticker)
  if (!raw) return 0
  if (tipo === 'CEDEAR' && ratio && ratio > 0) return raw / ratio
  return raw
}

const PIN_SALT = 'telegram-portfolio-bot-v2'

async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(PIN_SALT), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  )
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function parseCommand(text: string): ParsedCommand | null {
  const parts = text.trim().split(/\s+/)
  if (parts.length === 0) return null

  const type = parts[0].toLowerCase()

  if (type === 'resumen') {
    return { type: 'resumen' }
  }

  if (type === 'estado') {
    return { type: 'estado' }
  }

  if (type === 'pausar') {
    return { type: 'pausar' }
  }

  if (type === 'reanudar') {
    if (parts.length < 2) return null
    return { type: 'reanudar', pin: parts[1] }
  }

  if (type === 'activo') {
    if (parts.length < 2) return null
    const ticker = parts[1].toUpperCase()
    if (!TICKER_RE.test(ticker)) return null
    return { type: 'activo', activo: ticker }
  }

  if (type === 'historial') {
    if (parts.length < 2) return null
    const ticker = parts[1].toUpperCase()
    if (!TICKER_RE.test(ticker)) return null
    return { type: 'historial', activo: ticker }
  }

  if (type === 'swap') {
    if (parts.length < 7) return null
    const cantidad = parseFloat(parts[1])
    const activo = parts[2].toUpperCase()
    const cantidad2 = parseFloat(parts[3])
    const activo2 = parts[4].toUpperCase()
    const broker = parts[5].toUpperCase()
    if (isNaN(cantidad) || isNaN(cantidad2) || cantidad <= 0 || cantidad2 <= 0 || cantidad > MAX_CANTIDAD || cantidad2 > MAX_CANTIDAD) return null
    if (!TICKER_RE.test(activo) || !TICKER_RE.test(activo2)) return null
    return { type: 'swap', cantidad, activo, cantidad2, activo2, broker, pin: parts[6] }
  }

  if (type === 'ingreso' || type === 'retiro') {
    if (parts.length < 5) return null
    const cantidad = parseFloat(parts[1])
    const activo = parts[2].toUpperCase()
    const broker = parts[3].toUpperCase()
    if (isNaN(cantidad) || cantidad <= 0 || cantidad > MAX_CANTIDAD) return null
    if (!TICKER_RE.test(activo)) return null
    return { type, cantidad, activo, broker, pin: parts[4] }
  }

  if (type === 'alerta') {
    if (parts.length < 5) return null
    const activo = parts[1].toUpperCase()
    const direction = parts[2].toLowerCase()
    const precio = parseFloat(parts[3])
    if (!TICKER_RE.test(activo)) return null
    if (direction !== 'above' && direction !== 'below') return null
    if (isNaN(precio) || precio <= 0) return null
    return { type: 'alerta', activo, direction, precio, pin: parts[4] }
  }

  if (type === 'alertas') {
    return { type: 'alertas' }
  }

  if (type === 'borralerta') {
    if (parts.length < 3) return null
    const activo = parts[1].toUpperCase()
    if (!TICKER_RE.test(activo)) return null
    return { type: 'borralerta', activo, pin: parts[2] }
  }

  if (type === 'concentracion') {
    return { type: 'concentracion' }
  }

  if (type === 'futuros') {
    return { type: 'futuros' }
  }

  if (type === 'futuro') {
    // futuro <ACTIVO> <LONG|SHORT> <cantidad> <precio_entrada> <precio_salida> <pnl_usd> <pin>
    if (parts.length < 8) return null
    const activo = parts[1].toUpperCase()
    const direccion = parts[2].toUpperCase()
    const cantidad = parseFloat(parts[3])
    const precio_entrada = parseFloat(parts[4])
    const precio_salida = parseFloat(parts[5])
    const pnl_usd = parseFloat(parts[6])
    const pin = parts[7]
    if (!TICKER_RE.test(activo)) return null
    if (direccion !== 'LONG' && direccion !== 'SHORT') return null
    if (isNaN(cantidad) || cantidad <= 0 || cantidad > MAX_CANTIDAD) return null
    if (isNaN(precio_entrada) || precio_entrada <= 0) return null
    if (isNaN(precio_salida) || precio_salida <= 0) return null
    if (isNaN(pnl_usd)) return null
    return { type: 'futuro', activo, direccion, cantidad, precio_entrada, precio_salida, pnl_usd, pin }
  }

  if (type === 'compra' || type === 'vende') {
    if (parts.length < 7) return null
    const cantidad = parseFloat(parts[1])
    const activo = parts[2].toUpperCase()
    const precio = parseFloat(parts[3])
    const broker = parts[4].toUpperCase()
    const tipo = parts[5].toUpperCase()
    if (isNaN(cantidad) || isNaN(precio) || cantidad <= 0 || precio <= 0 || cantidad > MAX_CANTIDAD) return null
    if (!TICKER_RE.test(activo)) return null
    if (!['CEDEAR', 'STOCK', 'CRYPTO', 'CASH'].includes(tipo)) return null
    let ratio: number | undefined
    let pin: string | undefined
    // format: compra <cant> <activo> <precio> <BROKER> <TIPO> [ratio] <pin>
    if (parts.length >= 8) {
      ratio = parseFloat(parts[6])
      pin = parts[7]
      if (isNaN(ratio) || ratio <= 0) return null
    } else if (parts.length === 7) {
      pin = parts[6]
    }
    return { type, cantidad, activo, precio, broker, tipo, ratio, pin }
  }

  return null
}

function inferAssetType(activo: string, brokerName: string): string {
  if (activo === 'USD') return 'CASH'
  if (['USDC', 'BTC', 'ETH'].includes(activo)) return 'CRYPTO'
  const brokerTypes: Record<string, string> = { BULLMARKET: 'CEDEAR', BUENBIT: 'STOCK', DOLARAPP: 'STOCK', BINANCE: 'CRYPTO', BLOFIN: 'CRYPTO', NEXO: 'CRYPTO' }
  return brokerTypes[brokerName] || 'STOCK'
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const body = { chat_id: chatId, text, parse_mode: 'Markdown' }
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch (err) {
    console.error('Failed to send Telegram message:', err)
  }
}

serve(async (req: Request) => {
  const headers = { 'Content-Type': 'application/json' }

  // Layer 1: Verify webhook secret token
  const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || ''
  const receivedSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || ''
  if (expectedSecret && receivedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers })
  }

  // Rate limiting by IP
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown'
  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: 'too many requests' }), { status: 429, headers })
  }

  // Parse Telegram update
  let update: TelegramUpdate
  try {
    update = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400, headers })
  }

  const msg = update.message
  if (!msg?.text || !msg.chat?.id) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
  }

  const chatId = msg.chat.id
  const messageId = msg.message_id
  const text = msg.text.trim()

  // Initialize Supabase client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const supabase = createClient(supabaseUrl, supabaseKey)

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
  const reply = (t: string) => sendTelegramMessage(botToken, chatId, t)

  try {
    // Layer 2: User ID allowlist
    const { data: configData, error: configErr } = await supabase
      .from('config')
      .select('clave, valor')

    if (configErr) throw new Error(`Config query failed: ${configErr.message}`)

    const config: Record<string, string> = {}
    for (const row of configData || []) {
      config[row.clave] = row.valor
    }

    const allowedUserId = config['telegram_allowed_user_id']
    if (allowedUserId && String(chatId) !== allowedUserId) {
      await reply('⛔ No autorizado')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    // Layer 3: Dedup (prevent replay attacks)
    const { data: existingLog } = await supabase
      .from('audit_log')
      .select('id')
      .eq('chat_id', chatId)
      .eq('message_id', messageId)
      .limit(1)

    if (existingLog && existingLog.length > 0) {
      return new Response(JSON.stringify({ ok: true, dedup: true }), { status: 200, headers })
    }

    // Layer 5: Kill switch check
    const isPaused = config['telegram_paused'] === 'true'

    // Parse command
    const cmd = parseCommand(text)
    if (!cmd) {
      await reply(
        '❌ Comando no reconocido.\n\n' +
        'Formatos:\n' +
        '• `compra <cant> <activo> <precio> <BROKER> <TIPO> [ratio] <pin>`\n' +
        '• `vende <cant> <activo> <precio> <BROKER> <TIPO> [ratio] <pin>`\n' +
        '   TIPO: CEDEAR | STOCK | CRYPTO | CASH\n' +
        '   ratio: obligatorio solo para CEDEARs (ej: 50 para GLD)\n' +
        '   pin: obligatorio para toda operación\n' +
        '• `swap <cant_vendo> <activo_vendo> <cant_compro> <activo_compro> <BROKER> <pin>`\n' +
        '   activo-vendo debe ser USD o USDC (stablecoin a $1)\n' +
        '• `ingreso <cant> <activo> <BROKER> <pin>`\n' +
        '• `retiro <cant> <activo> <BROKER> <pin>`\n' +
        '   activo: USD o USDC (stablecoin a $1)\n' +
        '• `alerta <ACTIVO> <above|below> <precio> <pin>`\n' +
        '• `borralerta <ACTIVO> <pin>` — eliminar alertas de un activo\n' +
        '• `alertas` — listar alertas activas\n' +
        '• `resumen` — resumen general\n' +
        '• `estado` — detalle activo por activo\n' +
        '• `activo <TICKER>` — detalle de un activo\n' +
        '• `historial <TICKER>` — transacciones del activo\n' +
        '• `concentracion` — alertas de concentración\n' +
        '• `futuro <ACTIVO> <LONG|SHORT> <cant> <precio_ent> <precio_sal> <pnl_usd> <pin>`\n' +
        '• `futuros` — historial de futuros cerrados\n' +
        '• `pausar`\n' +
        '• `reanudar <pin>`'
      )
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    // Handle kill switch commands
    if (cmd.type === 'pausar') {
      await supabase.from('config').update({ valor: 'true' }).eq('clave', 'telegram_paused')
      await reply('⏸️ Bot pausado. Usa `reanudar <pin>` para reactivar.')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    if (cmd.type === 'reanudar') {
      if (!cmd.pin) {
        await reply('❌ Debes proporcionar el PIN: `reanudar <pin>`')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
      }
      const storedHash = config['telegram_pin_hash'] || ''
      const inputHash = await hashPin(cmd.pin)
      if (inputHash !== storedHash) {
        await reply('❌ PIN incorrecto')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
      }
      await supabase.from('config').update({ valor: 'false' }).eq('clave', 'telegram_paused')
      await reply('▶️ Bot reactivado.')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    // If paused, reject all other commands
    if (isPaused) {
      await reply('⏸️ Bot pausado. Usa `reanudar <pin>` para reactivar.')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    // Layer 4: PIN verification for trades
    if (cmd.type === 'compra' || cmd.type === 'vende' || cmd.type === 'swap' || cmd.type === 'ingreso' || cmd.type === 'retiro' || cmd.type === 'alerta' || cmd.type === 'borralerta' || cmd.type === 'futuro') {
      const storedHash = config['telegram_pin_hash'] || ''
      if (storedHash) {
        if (!cmd.pin) {
          const format = cmd.type === 'swap'
            ? 'swap <cant_vendo> <activo_vendo> <cant_compro> <activo_compro> <BROKER> <pin>'
            : '`' + cmd.type + ' <cant> <activo> <precio> <BROKER> <TIPO> [ratio] <pin>`'
          await reply('❌ PIN requerido. Formato: `' + format)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }
        const inputHash = await hashPin(cmd.pin)
        if (inputHash !== storedHash) {
          await reply('❌ PIN incorrecto')
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }
      }
    }

    // Layer 6: Audit log (before execution)
    const parsedJson = JSON.stringify(cmd)
    const { data: auditEntry, error: auditErr } = await supabase
      .from('audit_log')
      .insert({
        source: 'telegram',
        chat_id: chatId,
        message_id: messageId,
        raw_message: text,
        parsed_command: parsedJson,
        caller_ip: ip,
        status: 'pending',
      })
      .select('id')
      .single()

    if (auditErr) throw new Error(`Audit log failed: ${auditErr.message}`)
    const auditId = auditEntry.id

    try {
      if (cmd.type === 'resumen') {
        // Query all current holdings for accurate calculation
        const { data: holdings, error: hErr } = await supabase
          .from('holdings_current')
          .select('*')

        if (hErr) throw new Error(`Holdings query failed: ${hErr.message}`)

        if (holdings && holdings.length > 0) {
          const priceCache = await fetchLivePrices(holdings)
          await savePricesToHistory(supabase, priceCache)
          let totalValor = 0
          let totalInvertido = 0
          let totalPnl = 0
          let liquidez = 0
          let activosCount = 0

          for (const h of holdings) {
            const cant = parseFloat(h.cantidad) || 0
            const inv = parseFloat(h.invertido_usd) || 0
            const ratio = parseFloat(h.ratio) || undefined
            const precio = getLivePrice(h.activo, h.tipo, ratio, priceCache) || parseFloat(h.precio_usd) || 0
            const valor = cant * precio
            const pnl = valor - inv

            totalValor += valor
            totalInvertido += inv
            totalPnl += pnl

            if ((h.tipo === 'CASH' && h.activo === 'USD') ||
                (h.tipo === 'CRYPTO' && h.activo === 'USDC')) {
              liquidez += valor
            }

            if (cant > 0) activosCount++
          }

          const invertidoProductivo = totalInvertido - liquidez
          const retornoPct = invertidoProductivo > 0
            ? (totalPnl / invertidoProductivo) * 100
            : 0
          const dashToken = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || ''

          const replyText =
            '📊 *RESUMEN DE CARTERA*\n\n' +
            `Valor total: $${totalValor.toFixed(2)}\n` +
            `Invertido: $${invertidoProductivo.toFixed(2)} (sin liquidez)\n` +
            `Liquidez: $${liquidez.toFixed(2)}\n` +
            `PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` +
            ` (${retornoPct.toFixed(2)}% s/liquidez)\n` +
            `Activos: ${activosCount}\n\n` +
            `[📊 Dashboard](${dashToken ? 'https://jpmanucha.github.io/portfolio-dashboard/?k=' + dashToken : ''})`
          await reply(replyText)
        } else {
          await reply('📊 No hay datos de cartera disponibles.')
        }

        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'estado') {
        const { data: holdings } = await supabase
          .from('holdings_current')
          .select('*')

        if (!holdings || holdings.length === 0) {
          await reply('📊 No hay activos en la cartera.')
          await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        // Aggregate by asset, exclude USD and USDC, normalize CEDEARs by ratio
        const priceCache = await fetchLivePrices(holdings)
        await savePricesToHistory(supabase, priceCache)
        const agg: Record<string, { cant: number; costoTotal: number; invertido: number; valor: number; currentPrice: number }> = {}
        for (const h of holdings) {
          if (h.activo === 'USD' || h.activo === 'USDC') continue
          let cant = parseFloat(h.cantidad) || 0
          if (cant <= 0) continue
          let costo = parseFloat(h.costo_promedio) || 0
          const inv = parseFloat(h.invertido_usd) || 0
          const ratio = parseFloat(h.ratio) || 1
          const rawPrice = getLivePrice(h.activo, h.tipo, ratio === 1 ? undefined : ratio, priceCache) || parseFloat(h.precio_usd) || 0
          let precio = rawPrice
          let valor = cant * rawPrice

          // Normalize CEDEARs: convert to equivalent underlying shares
          if (h.tipo === 'CEDEAR' && ratio > 0 && ratio !== 1) {
            cant = cant / ratio
            costo = costo * ratio
            precio = rawPrice * ratio
            valor = cant * precio
          }

          if (!agg[h.activo]) {
            agg[h.activo] = { cant: 0, costoTotal: 0, invertido: 0, valor: 0, currentPrice: precio }
          }
          agg[h.activo].cant += cant
          agg[h.activo].costoTotal += costo * cant
          agg[h.activo].invertido += inv
          agg[h.activo].valor += valor
        }

        const sorted = Object.entries(agg).sort((a, b) => b[1].valor - a[1].valor)

        let replyText = '📋 *ESTADO POR ACTIVO*\n\n'
        let totalValor = 0

        for (const [activo, data] of sorted) {
          const costoProm = data.cant > 0 ? data.costoTotal / data.cant : 0
          const precioActual = data.cant > 0 ? data.valor / data.cant : data.currentPrice
          const difPct = costoProm > 0 ? ((precioActual - costoProm) / costoProm) * 100 : 0
          const pnlUsd = data.valor - data.invertido
          const pnlPct = data.invertido > 0 ? (pnlUsd / data.invertido) * 100 : 0
          totalValor += data.valor

          const emoji = difPct >= 0 ? '🟢' : '🔴'
          const signDif = difPct >= 0 ? '+' : ''
          const signPct = pnlPct >= 0 ? '+' : ''
          const signUsd = pnlUsd >= 0 ? '+' : ''

          replyText +=
            `${emoji} *${activo}*\n` +
            `  Cant: ${data.cant.toFixed(4)} | Invertido: $${data.invertido.toFixed(2)}\n` +
            `  Costo prom: $${costoProm.toFixed(2)} → Actual: $${precioActual.toFixed(2)}\n` +
            `  Rend: ${signDif}${difPct.toFixed(2)}% | PnL: ${signPct}${pnlPct.toFixed(2)}% (${signUsd}$${Math.abs(pnlUsd).toFixed(2)})\n\n`
        }

        replyText += `━━━━━━━━━━━━━━━━━━━\n*Valor total (volátil): $${totalValor.toFixed(2)}*`
        await reply(replyText)
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'activo') {
        const ticker = cmd.activo!

        // Get all holdings for total portfolio value (with live prices)
        const { data: allHoldings } = await supabase
          .from('holdings_current')
          .select('*')

        const allPriceCache = await fetchLivePrices(allHoldings || [])
        await savePricesToHistory(supabase, allPriceCache)

        let totalValor = 0
        for (const h of allHoldings || []) {
          const r = parseFloat(h.ratio) || undefined
          const p = getLivePrice(h.activo, h.tipo, r, allPriceCache) || parseFloat(h.precio_usd) || 0
          totalValor += (parseFloat(h.cantidad) || 0) * p
        }

        // Get holding details for this asset
        const { data: holdings } = await supabase
          .from('holdings_current')
          .select('*')
          .eq('activo', ticker)

        if (!holdings || holdings.length === 0) {
          await reply(`❌ Activo "${ticker}" no encontrado en la cartera.`)
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Asset not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        // Get first transaction date for this asset
        const { data: firstTx } = await supabase
          .from('transactions')
          .select('fecha, operacion')
          .eq('activo', ticker)
          .order('fecha', { ascending: true })
          .limit(1)

        let replyText = `📈 *${ticker}*\n\n`

        for (const h of holdings) {
          const cant = parseFloat(h.cantidad) || 0
          const inv = parseFloat(h.invertido_usd) || 0
          const ratio = parseFloat(h.ratio) || undefined
          const precio = getLivePrice(h.activo, h.tipo, ratio, allPriceCache) || parseFloat(h.precio_usd) || 0
          const valor = cant * precio
          const pnl = valor - inv
          const pnlPct = inv > 0 ? (pnl / inv) * 100 : 0
          const pctPortfolio = totalValor > 0 ? (valor / totalValor) * 100 : 0

          replyText += `*${h.broker}* (${h.tipo})\n`
          if (h.ratio) replyText += `Ratio: ${h.ratio}\n`
          replyText += `Cantidad: ${cant}\n`
          replyText += `Precio: $${precio.toFixed(2)}\n`
          replyText += `Valor: $${valor.toFixed(2)} (${pctPortfolio.toFixed(1)}% del port.)\n`
          replyText += `Invertido: $${inv.toFixed(2)}\n`
          replyText += `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n\n`
        }

        if (firstTx && firstTx.length > 0) {
          const fechaCompra = new Date(firstTx[0].fecha)
          const hoy = new Date()
          const dias = Math.floor((hoy.getTime() - fechaCompra.getTime()) / (1000 * 60 * 60 * 24))
          replyText += `🕐 Tenencia: ~${dias} días (desde ${firstTx[0].fecha})`
        }

        await reply(replyText)
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'historial') {
        const ticker = cmd.activo!

        const { data: txs } = await supabase
          .from('transactions')
          .select('*, brokers!inner(name), asset_types!inner(name)')
          .eq('activo', ticker)
          .order('fecha', { ascending: false })

        if (!txs || txs.length === 0) {
          await reply(`❌ No hay transacciones de "${ticker}".`)
          await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        const totalTxs = txs.length
        const compras = txs.filter(t => t.operacion === 'Compra').length
        const ventas = txs.filter(t => t.operacion === 'Venta').length
        const totalComprado = txs.filter(t => t.operacion === 'Compra').reduce((s, t) => s + parseFloat(t.total_usd || 0), 0)
        const totalVendido = txs.filter(t => t.operacion === 'Venta').reduce((s, t) => s + parseFloat(t.total_usd || 0), 0)

        let replyText = `📜 *${ticker} — Historial*\n\n`
        replyText += `Total: ${totalTxs} ops (${compras} compras, ${ventas} ventas)\n`
        replyText += `Comprado: $${totalComprado.toFixed(2)} | Vendido: $${totalVendido.toFixed(2)}\n\n`

        // Show last 5 transactions
        const ultimas = txs.slice(0, 5)
        for (const t of ultimas) {
          const emoji = t.operacion === 'Compra' ? '🟢' : '🔴'
          replyText +=
            `${emoji} ${t.fecha} | ${t.operacion} ${parseFloat(t.cantidad).toFixed(4)}` +
            ` @ $${parseFloat(t.precio_unitario_usd || 0).toFixed(2)}` +
            ` = $${parseFloat(t.total_usd || 0).toFixed(2)} (${t.brokers?.name || ''})\n`
        }

        if (totalTxs > 5) {
          replyText += `\n... y ${totalTxs - 5} transacciones más.`
        }

        await reply(replyText)
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'concentracion') {
        const { data: alerts } = await supabase
          .from('concentration_alerts')
          .select('*')
          .order('valor_usd', { ascending: false })

        if (!alerts || alerts.length === 0) {
          await reply('✅ No hay concentraciones significativas (>5%).')
          await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        let replyText = '⚠️ *ALERTAS DE CONCENTRACIÓN*\n\n'
        for (const a of alerts) {
          const emoji = a.alert_level === 'CRITICAL' ? '🔴' : a.alert_level === 'WARNING' ? '🟡' : '⚪'
          replyText +=
            `${emoji} *${a.activo}* (${a.broker}) — ${a.pct_portfolio}%\n` +
            `   Valor: $${parseFloat(a.valor_usd).toFixed(2)} | ${a.alert_level}\n\n`
        }
        await reply(replyText)
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'futuros') {
        const { data: futures, error: fErr } = await supabase
          .from('futures_closed')
          .select('*, brokers!inner(name)')
          .order('fecha_cierre', { ascending: false })
          .limit(20)

        if (fErr) throw new Error(`Futures query failed: ${fErr.message}`)

        if (!futures || futures.length === 0) {
          await reply('📈 No hay operaciones de futuros registradas.')
          await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        const totalPnl = futures.reduce((sum, f) => sum + parseFloat(f.pnl_usd || 0), 0)
        const wins = futures.filter(f => parseFloat(f.pnl_usd) > 0).length
        const losses = futures.filter(f => parseFloat(f.pnl_usd) < 0).length

        let replyText = '📈 *HISTORIAL DE FUTUROS*\n\n'
        replyText += `Total ops: ${futures.length} | Wins: ${wins} | Losses: ${losses}\n`
        replyText += `PnL total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n\n`

        for (const f of futures.slice(0, 10)) {
          const emoji = parseFloat(f.pnl_usd) >= 0 ? '🟢' : '🔴'
          replyText +=
            `${emoji} ${f.fecha_cierre} | ${f.activo} ${f.direccion}\n` +
            `   Entrada: $${parseFloat(f.precio_entrada).toFixed(2)} → Salida: $${parseFloat(f.precio_salida).toFixed(2)}\n` +
            `   Cantidad: ${f.cantidad} | PnL: ${parseFloat(f.pnl_usd) >= 0 ? '+' : ''}$${parseFloat(f.pnl_usd).toFixed(2)} (${f.brokers?.name})\n\n`
        }

        await reply(replyText)
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'futuro') {
        const brokerName = 'BLOFIN' // Default broker for futures
        const activo = cmd.activo!
        const direccion = cmd.direccion!
        const cantidad = cmd.cantidad!
        const precio_entrada = cmd.precio_entrada!
        const precio_salida = cmd.precio_salida!
        const pnl_usd = cmd.pnl_usd!
        const today = new Date().toISOString().split('T')[0]

        // Lookup broker
        const { data: brokerData } = await supabase
          .from('brokers')
          .select('id')
          .ilike('name', brokerName)
          .limit(1)

        if (!brokerData || brokerData.length === 0) {
          await reply(`❌ Broker "${brokerName}" no encontrado. Válidos: BULLMARKET, BUENBIT, DOLARAPP, BINANCE, BLOFIN`)
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Broker not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        const brokerId = brokerData[0].id

        // Insert futures closed position
        const { error: txErr } = await supabase.from('futures_closed').insert({
          broker_id: brokerId,
          activo,
          direccion,
          cantidad,
          precio_entrada,
          precio_salida,
          pnl_usd,
          fecha_cierre: today,
        })

        if (txErr) throw new Error(`Futures insert failed: ${txErr.message}`)

        const emoji = pnl_usd >= 0 ? '📈' : '📉'
        await reply(
          `${emoji} *Futuro cerrado registrado*\n` +
          `${activo} ${direccion} | Cantidad: ${cantidad}\n` +
          `Entrada: $${precio_entrada.toFixed(2)} → Salida: $${precio_salida.toFixed(2)}\n` +
          `PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd.toFixed(2)} en *${brokerName}*`
        )
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'ingreso' || cmd.type === 'retiro') {
        const brokerName = cmd.broker!
        const activo = cmd.activo!
        const cantidad = cmd.cantidad!
        const operacion = cmd.type === 'ingreso' ? 'Ingreso' : 'Retiro'

        const { data: brokerData } = await supabase
          .from('brokers').select('id').ilike('name', brokerName).limit(1)
        if (!brokerData || brokerData.length === 0) {
          await reply(`❌ Broker "${brokerName}" no encontrado.`)
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Broker not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }
        const brokerId = brokerData[0].id

        const tipo = inferAssetType(activo, brokerName)
        const { data: atData } = await supabase.from('asset_types').select('id').eq('name', tipo).limit(1)
        if (!atData || atData.length === 0) {
          await reply('❌ Tipo de activo no valido.')
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Asset type not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }
        const atId = atData[0].id
        const today = new Date().toISOString().split('T')[0]
        const total = cantidad

        // Insert transaction
        const { error: txErr } = await supabase.from('transactions').insert({
          broker_id: brokerId, asset_type_id: atId, activo, fecha: today,
          operacion, cantidad, precio_unitario_usd: 1, total_usd: total,
        })
        if (txErr) throw new Error(`Transaction insert failed: ${txErr.message}`)

        // Update holding quantity
        const { data: existing } = await supabase
          .from('holdings').select('id, cantidad, invertido_usd, pnl_realizado_usd')
          .eq('activo', activo).eq('broker_id', brokerId).eq('asset_type_id', atId)
          .order('snapshot_date', { ascending: false }).limit(1)

        if (existing && existing.length > 0) {
          const h = existing[0]
          const oldCant = parseFloat(h.cantidad) || 0
          const oldInv = parseFloat(h.invertido_usd) || 0
          if (operacion === 'Ingreso') {
            const newCant = oldCant + cantidad
            await supabase.from('holdings').update({
              cantidad: newCant, invertido_usd: oldInv + total,
              precio_usd: 1, valor_usd: newCant * 1, snapshot_date: today,
            }).eq('id', h.id)
          } else {
            const newCant = Math.max(0, oldCant - cantidad)
            const costBasis = oldCant > 0 ? (oldInv / oldCant) * cantidad : 0
            const realizedPnL = total - costBasis
            const oldRealized = parseFloat(h.pnl_realizado_usd) || 0
            const upd: Record<string, unknown> = {
              cantidad: newCant, precio_usd: 1, valor_usd: newCant * 1,
              snapshot_date: today, pnl_realizado_usd: oldRealized + realizedPnL,
            }
            if (newCant === 0) upd.invertido_usd = 0
            else upd.invertido_usd = Math.max(0, oldInv - costBasis)
            await supabase.from('holdings').update(upd).eq('id', h.id)
          }
        } else {
          await supabase.from('holdings').insert({
            broker_id: brokerId, asset_type_id: atId, activo, cantidad,
            costo_promedio: 1, moneda_costo: 'USD', invertido_usd: total,
            precio_usd: 1, valor_usd: total, snapshot_date: today,
          })
        }

        const emoji = operacion === 'Ingreso' ? '💰' : '🏧'
        await reply(
          `${emoji} *${operacion} registrado*\n` +
          `$${total.toFixed(2)} ${activo} en *${brokerName}*`
        )
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'alerta') {
        const activo = cmd.activo!
        const direction = cmd.direction!
        const precio = cmd.precio!
        const ytMap: Record<string, string> = { 'BTC': 'BTC-USD', 'ETH': 'ETH-USD', 'BRK.B': 'BRK-B' }
        const ytTicker = ytMap[activo] || activo

        const { error: insertErr } = await supabase.from('price_alerts').insert({
          activo: ytTicker, threshold_usd: precio, direction, enabled: true,
        })
        if (insertErr) throw new Error(`Alert insert failed: ${insertErr.message}`)

        await reply(
          `🔔 *Alerta creada*\n` +
          `${activo} ${direction === 'above' ? '>' : '<'} $${precio.toFixed(2)}\n` +
          `Te avisare cuando se cumpla la condicion.`
        )
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'alertas') {
        const { data: alerts, error: aErr } = await supabase
          .from('price_alerts')
          .select('id, activo, threshold_usd, direction, enabled, last_triggered_date, created_at')
          .order('created_at', { ascending: false })

        if (aErr) throw new Error(`Alerts query failed: ${aErr.message}`)

        if (!alerts || alerts.length === 0) {
          await reply('🔔 No tienes alertas configuradas. Usa `alerta <ACTIVO> <above|below> <precio> <pin>` para crear una.')
          await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        let replyText = '🔔 *ALERTAS DE PRECIO*\n\n'
        for (const a of alerts) {
          const status = a.enabled ? (a.last_triggered_date ? `✅ (ultima: ${a.last_triggered_date})` : '🔍 activa') : '⏸️ pausada'
          const symbol = a.activo.replace('-USD', '')
          replyText += `${symbol} ${a.direction === 'above' ? '>' : '<'} $${a.threshold_usd.toFixed(2)} — ${status}\n`
        }
        await reply(replyText)
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'borralerta') {
        const activo = cmd.activo!
        const ytMap: Record<string, string> = { 'BTC': 'BTC-USD', 'ETH': 'ETH-USD', 'BRK.B': 'BRK-B' }
        const ytTicker = ytMap[activo] || activo

        const { data: deleted, error: delErr } = await supabase
          .from('price_alerts')
          .delete()
          .eq('activo', ytTicker)
          .select('id')

        if (delErr) throw new Error(`Alert delete failed: ${delErr.message}`)

        if (!deleted || deleted.length === 0) {
          await reply(`🔔 No hay alertas para ${activo}.`)
        } else {
          await reply(`🗑️ Alertas eliminadas para ${activo}: ${deleted.length} borrada(s).`)
        }
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'swap') {
        const brokerName = cmd.broker!
        const activo1 = cmd.activo!
        const activo2 = cmd.activo2!
        const cant1 = cmd.cantidad!
        const cant2 = cmd.cantidad2!
        const total = cant1  // vendo side determines total (USD/USDC = $1)

        if (activo1 === activo2) {
          await reply('❌ No podés swapear un activo por sí mismo.')
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Same asset swap' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        if (!['USD', 'USDC'].includes(activo1)) {
          await reply('❌ El activo a vender debe ser USD o USDC. Para otros swaps usá `vende` + `compra` por separado.')
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Non-stablecoin swap' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        // Lookup broker
        const { data: brokerData } = await supabase
          .from('brokers')
          .select('id')
          .ilike('name', brokerName)
          .limit(1)

        if (!brokerData || brokerData.length === 0) {
          await reply(`❌ Broker "${brokerName}" no encontrado. Válidos: BULLMARKET, BUENBIT, DOLARAPP, BINANCE, BLOFIN, NEXO`)
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Broker not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        const brokerId = brokerData[0].id

        // Infer types for both legs
        const tipo1 = inferAssetType(activo1, brokerName)
        const tipo2 = inferAssetType(activo2, brokerName)

        const { data: atData } = await supabase.from('asset_types').select('id, name').in('name', [tipo1, tipo2])
        const atMap = new Map((atData || []).map((r: any) => [r.name, r.id]))
        const atId1 = atMap.get(tipo1) || null
        const atId2 = atMap.get(tipo2) || null

        if (!atId1 || !atId2) {
          await reply('❌ Tipo de activo no válido.')
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Asset type not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        const today = new Date().toISOString().split('T')[0]
        const precio2 = total / cant2

        // Insert Venta (stablecoin) + Compra (target asset)
        const { error: tx1Err } = await supabase.from('transactions').insert({
          broker_id: brokerId, asset_type_id: atId1, activo: activo1,
          fecha: today, operacion: 'Venta', cantidad: cant1,
          precio_unitario_usd: 1, total_usd: total,
        })
        if (tx1Err) throw new Error(`Swap venta insert failed: ${tx1Err.message}`)

        const { error: tx2Err } = await supabase.from('transactions').insert({
          broker_id: brokerId, asset_type_id: atId2, activo: activo2,
          fecha: today, operacion: 'Compra', cantidad: cant2,
          precio_unitario_usd: precio2, total_usd: total,
        })
        if (tx2Err) throw new Error(`Swap compra insert failed: ${tx2Err.message}`)

        // Update holdings: reduce stablecoin
        const { data: h1 } = await supabase
          .from('holdings').select('id, cantidad, invertido_usd, pnl_realizado_usd')
          .eq('activo', activo1).eq('broker_id', brokerId).eq('asset_type_id', atId1)
          .order('snapshot_date', { ascending: false }).limit(1)

        if (h1 && h1.length > 0) {
          const oldCant = parseFloat(h1[0].cantidad) || 0
          const newCant = Math.max(0, oldCant - cant1)
          const oldInv = parseFloat(h1[0].invertido_usd) || 0
          const costBasis = oldCant > 0 ? (oldInv / oldCant) * cant1 : 0
          const realizedPnL = total - costBasis
          const oldRealized = parseFloat(h1[0].pnl_realizado_usd) || 0
          const upd: Record<string, unknown> = { cantidad: newCant, precio_usd: 1, valor_usd: newCant * 1, snapshot_date: today, pnl_realizado_usd: oldRealized + realizedPnL }
          if (newCant === 0) upd.invertido_usd = 0
          else upd.invertido_usd = Math.max(0, oldInv - costBasis)
          await supabase.from('holdings').update(upd).eq('id', h1[0].id)
        }

        // Update holdings: increase target asset
        const { data: h2 } = await supabase
          .from('holdings').select('id, cantidad, costo_promedio, invertido_usd')
          .eq('activo', activo2).eq('broker_id', brokerId).eq('asset_type_id', atId2)
          .order('snapshot_date', { ascending: false }).limit(1)

        if (h2 && h2.length > 0) {
          const oldCant = parseFloat(h2[0].cantidad) || 0
          const oldCosto = parseFloat(h2[0].costo_promedio) || 0
          const oldInv = parseFloat(h2[0].invertido_usd) || 0
          const newCant = oldCant + cant2
          const newCosto = (oldCosto * oldCant + precio2 * cant2) / newCant
          await supabase.from('holdings').update({
            cantidad: newCant, costo_promedio: newCosto, invertido_usd: oldInv + total,
            precio_usd: precio2, valor_usd: newCant * precio2, snapshot_date: today,
          }).eq('id', h2[0].id)
        } else {
          await supabase.from('holdings').insert({
            broker_id: brokerId, asset_type_id: atId2, activo: activo2,
            cantidad: cant2, costo_promedio: precio2, moneda_costo: 'USD',
            invertido_usd: total, precio_usd: precio2, valor_usd: total, snapshot_date: today,
          })
        }

        await reply(
          `🔄 *Swap completado*\n` +
          `${activo1} -$${total.toFixed(2)} (${cant1}) → ${activo2} +$${total.toFixed(2)} (${cant2.toFixed(8)}) en *${brokerName}*\n` +
          `Precio ${activo2}: $${precio2.toFixed(4)}`
        )
        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }

      if (cmd.type === 'compra' || cmd.type === 'vende') {
        const brokerName = cmd.broker!
        const activo = cmd.activo!
        const cantidad = cmd.cantidad!
        const precio = cmd.precio!
        const total = cantidad * precio
        const operacion = cmd.type === 'compra' ? 'Compra' : 'Venta'

        // Lookup broker ID
        const { data: brokerData } = await supabase
          .from('brokers')
          .select('id')
          .ilike('name', brokerName)
          .limit(1)

        if (!brokerData || brokerData.length === 0) {
          await reply(`❌ Broker "${brokerName}" no encontrado. Válidos: BULLMARKET, BUENBIT, DOLARAPP, BINANCE, BLOFIN, NEXO`)
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Broker not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        const brokerId = brokerData[0].id

        const tipo = cmd.tipo!

        // Auto-fill ratio for CEDEARs if not provided
        if (!cmd.ratio && tipo === 'CEDEAR') {
          let found = getCedearRatio(activo, config)
          if (!found) found = await fetchCedearRatio(activo)
          if (found) cmd.ratio = found
        }

        // Lookup asset type from explicit TIPO
        const { data: atData } = await supabase
          .from('asset_types')
          .select('id')
          .eq('name', tipo)
          .limit(1)

        let assetTypeId: string | null = null
        if (atData && atData.length > 0) assetTypeId = atData[0].id

        if (!assetTypeId) {
          const { data: atAll } = await supabase.from('asset_types').select('id').limit(1)
          assetTypeId = atAll && atAll.length > 0 ? atAll[0].id : null
        }

        if (!assetTypeId) {
          await reply('❌ No se pudo determinar el tipo de activo.')
          await supabase.from('audit_log').update({ status: 'error', error_message: 'Asset type not found' }).eq('id', auditId)
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
        }

        // Insert transaction
        // Save ratio to config for future auto-lookup
        if (cmd.ratio) {
          const configKey = `cedear_ratio_${activo.replace('.', '')}`
          await supabase.from('config').upsert({ clave: configKey, valor: String(cmd.ratio) }, { onConflict: 'clave' })
        }

        const { error: txErr } = await supabase
          .from('transactions')
          .insert({
            broker_id: brokerId,
            asset_type_id: assetTypeId,
            activo: activo,
            fecha: new Date().toISOString().split('T')[0],
            operacion: operacion,
            cantidad: cantidad,
            precio_unitario_usd: precio,
            total_usd: total,
          })

        if (txErr) throw new Error(`Transaction insert failed: ${txErr.message}`)

        // Update holdings
        const { data: existingHolding } = await supabase
          .from('holdings')
          .select('id, cantidad, costo_promedio, invertido_usd, pnl_realizado_usd')
          .eq('activo', activo)
          .eq('broker_id', brokerId)
          .eq('asset_type_id', assetTypeId)
          .order('snapshot_date', { ascending: false })
          .limit(1)

        const today = new Date().toISOString().split('T')[0]

        if (operacion === 'Compra') {
          if (existingHolding && existingHolding.length > 0) {
            const h = existingHolding[0]
            const oldCantidad = parseFloat(h.cantidad) || 0
            const oldCosto = parseFloat(h.costo_promedio) || 0
            const oldInvertido = parseFloat(h.invertido_usd) || 0
            const newCantidad = oldCantidad + cantidad
            const newCosto = (oldCosto * oldCantidad + precio * cantidad) / newCantidad
            const newInvertido = oldInvertido + total

            const updateData: Record<string, unknown> = {
              cantidad: newCantidad,
              costo_promedio: newCosto,
              invertido_usd: newInvertido,
              precio_usd: precio,
              valor_usd: newCantidad * precio,
              snapshot_date: today,
            }
            if (cmd.ratio) updateData.ratio = cmd.ratio

            await supabase
              .from('holdings')
              .update(updateData)
              .eq('id', h.id)
          } else {
            const insertData: Record<string, unknown> = {
              broker_id: brokerId,
              asset_type_id: assetTypeId,
              activo: activo,
              cantidad: cantidad,
              costo_promedio: precio,
              moneda_costo: 'USD',
              invertido_usd: total,
              precio_usd: precio,
              valor_usd: total,
              snapshot_date: today,
            }
            if (cmd.ratio) insertData.ratio = cmd.ratio

            await supabase
              .from('holdings')
              .insert(insertData)
          }
        } else {
          // Venta
          if (existingHolding && existingHolding.length > 0) {
            const h = existingHolding[0]
            const oldCantidad = parseFloat(h.cantidad) || 0
            const newCantidad = Math.max(0, oldCantidad - cantidad)
            const oldInvertido = parseFloat(h.invertido_usd) || 0
            const costBasis = (oldCantidad > 0) ? (oldInvertido / oldCantidad) * cantidad : 0
            const realizedPnL = total - costBasis
            const oldRealized = parseFloat(h.pnl_realizado_usd) || 0

            const updateData: Record<string, unknown> = {
              cantidad: newCantidad,
              precio_usd: precio,
              valor_usd: newCantidad * precio,
              snapshot_date: today,
              pnl_realizado_usd: oldRealized + realizedPnL,
            }

            if (newCantidad === 0) {
              updateData.invertido_usd = 0
            } else {
              const remainingInvertido = oldInvertido - costBasis
              updateData.invertido_usd = Math.max(0, remainingInvertido)
            }

            await supabase.from('holdings').update(updateData).eq('id', h.id)
          } else {
            await supabase
              .from('holdings')
              .insert({
                broker_id: brokerId,
                asset_type_id: assetTypeId,
                activo: activo,
                cantidad: 0,
                precio_usd: precio,
                valor_usd: 0,
                snapshot_date: today,
                pnl_realizado_usd: total,
              })
          }
        }

        const emoji = operacion === 'Compra' ? '✅' : '🟢'
        const tipoStr = cmd.tipo ? ` (${cmd.tipo}${cmd.ratio ? `, ratio ${cmd.ratio}` : ''})` : ''
        const replyText =
          `${emoji} *${operacion} registrada*\n` +
          `${cantidad} ${activo} @ $${precio.toFixed(2)} en *${brokerName}*${tipoStr}\n` +
          `Total: $${total.toFixed(2)}`
        await reply(replyText)

        await supabase.from('audit_log').update({ status: 'success' }).eq('id', auditId)
      }
    } catch (execErr) {
      const errMsg = execErr instanceof Error ? execErr.message : 'Unknown error'
      await supabase.from('audit_log').update({ status: 'error', error_message: errMsg }).eq('id', auditId)
      await reply('❌ Error al procesar el comando. Revisá los datos e intentá de nuevo.')
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error('Fatal error:', errMsg)
    try {
      await reply('❌ Error interno del servidor.')
    } catch {
      // reply failed, ignore
    }
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
})
