/**
 * dsh-camofox-browser —— 宿主半边：把 camofox-browser 的反检测浏览器接成 DSH 原生工具。
 *
 * 为什么不是「再写一个 Playwright 封装」：
 *   camofox-browser 把 Camoufox（Firefox 的 C++ 层指纹伪装分支）包成 REST 服务，
 *   并且已经定义了 11 个工具的权威契约（mcp/lib/tool-contracts.mjs）。本插件不重写
 *   那套契约，只做三件 DSH 特有的事：
 *     1. 把 REST 端点翻译成一个 action-based 的 DSH 工具（不往工具表里塞 11 个名字）；
 *     2. 按需拉起后端服务（DSH 启动时不该常驻一个浏览器服务，第一次调用再起）；
 *     3. 接管两类「DSH 语义」的收尾 —— 图片落盘而不是塞进上下文、错误信息可读。
 *
 * 三个刻意的取舍，都写在对应位置：截图/快照图**落盘**（见 screenshot action）、
 * 服务进程由插件托管（见 ensureServer）、浏览器代理默认关闭（见 DEFAULTS.proxy）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 全部旋钮；bundle patch 里写同样的默认值。 */
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:9377',
  /** camofox-browser 源码目录（含 server.js）。 */
  serverDir: 'E:\\development\\camofox-browser',
  /**
   * Camoufox 引擎安装目录。留空 = 用 camoufox-js 的默认位置
   * （Windows: %LOCALAPPDATA%\camoufox\camoufox\Cache）。
   *
   * ⚠️ 变量名是 CAMOUFOX_INSTALL_DIR（含 U）。camoufox-js 认得的是这个；
   * camofox-browser 自己那批环境变量才是 CAMOFOX_ 前缀。写错不报错 ——
   * camoufox-js 会当作「没装」然后**静默重下 500MB**，所以默认留空最安全。
   */
  installDir: '',
  /** 引擎解压前的临时目录；不设则用 os.tmpdir()（C 盘，峰值约 600MB）。 */
  tempDir: 'E:\\caches\\tmp',
  nodePath: '',
  /** 会话所有者：决定 cookie/localStorage 分区（camofox 会按 userId 哈希落盘）。 */
  userId: 'dsh',
  sessionKey: 'default',
  /** true：第一次调用工具时若服务没在跑就自动拉起。 */
  autoStart: true,
  startTimeoutMs: 120000,
  requestTimeoutMs: 90000,
  /** 截图落盘目录；空则用 DSH 会话工作区下的 .camofox-shots。 */
  screenshotDir: '',
  /** 浏览器代理。默认关闭：直连时 Camoufox 不声明地理位置，身份更中性。 */
  proxy: { enabled: false, host: '127.0.0.1', port: '7897', username: '', password: '', protocol: 'http' },
  /** 单次返回给模型的文本上限，防止一次快照吃掉整个上下文。 */
  maxChars: 40000,
  env: {},
}

/** camofox 自带遥测默认是开的（往项目 GitHub 自动报 issue）。这里默认关掉。 */
const CAMOFOX_ENV = {
  CAMOFOX_CRASH_REPORT_ENABLED: 'false',
  /** 只监听回环：这个服务没有任何鉴权时可以被本机任意程序驱动。 */
  CAMOFOX_BIND_HOST: '127.0.0.1',
  NODE_OPTIONS: '--max-old-space-size=512',
}

/** 可以被 action 直接透传成 REST 的字段。 */
const SEARCH_MACROS = [
  '@google_search', '@youtube_search', '@amazon_search', '@reddit_search',
  '@reddit_subreddit', '@wikipedia_search', '@twitter_search', '@yelp_search',
  '@spotify_search', '@netflix_search', '@linkedin_search', '@instagram_search',
  '@tiktok_search', '@twitch_search',
]

function clip(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  const limit = Number(max) > 0 ? Number(max) : 0
  if (!limit || value.length <= limit) return value
  return `${value.slice(0, limit)}\n... [已截断，共 ${value.length} 字符；可用 offset 取后续快照] ...`
}

/** 必须带 tabId 的 action。前置统一校验，否则会先报出别的缺参，误导调用方。 */
const NEEDS_TAB = new Set([
  'snapshot', 'click', 'type', 'press', 'navigate', 'scroll',
  'screenshot', 'links', 'evaluate', 'text', 'close',
])

/** 每个 action 的 REST 规格。纯函数 —— 自测脚本直接断言它，不碰网络。 */
export function buildCall(args, opts = DEFAULTS) {
  const action = String((args && args.action) || '').toLowerCase()
  const userId = args.userId || opts.userId
  const sessionKey = args.sessionKey || opts.sessionKey
  const q = (extra = {}) => new URLSearchParams({ userId, ...extra }).toString()
  if (NEEDS_TAB.has(action) && !args.tabId) {
    throw new Error(`${action} 需要 tabId（先用 action=open 拿一个）`)
  }
  const tab = () => encodeURIComponent(String(args.tabId))

  switch (action) {
    case 'open':
      if (!args.url) throw new Error('open 需要 url')
      return { method: 'POST', path: '/tabs', body: { url: args.url, userId, sessionKey }, kind: 'json' }

    case 'snapshot':
      // includeScreenshot 默认关：截图会以 base64 塞进 JSON，等于把几 MB 字符串
      // 送进上下文。要图就用 action=screenshot（落盘）。
      return {
        method: 'GET',
        path: `/tabs/${tab()}/snapshot?${q(args.offset ? { offset: String(args.offset) } : {})}`,
        kind: 'snapshot',
      }

    case 'click':
      if (!args.ref && !args.selector) throw new Error('click 需要 ref（如 e1）或 selector')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/click`,
        body: { userId, ...(args.ref ? { ref: args.ref } : { selector: args.selector }) },
        kind: 'json',
      }

    case 'type':
      if (typeof args.text !== 'string') throw new Error('type 需要 text')
      if (!args.ref && !args.selector) throw new Error('type 需要 ref（如 e2）或 selector')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/type`,
        body: {
          userId,
          text: args.text,
          pressEnter: Boolean(args.pressEnter),
          ...(args.ref ? { ref: args.ref } : { selector: args.selector }),
        },
        kind: 'json',
      }

    case 'press':
      if (!args.key) throw new Error('press 需要 key（如 Enter / Escape）')
      return { method: 'POST', path: `/tabs/${tab()}/press`, body: { userId, key: args.key }, kind: 'json' }

    case 'navigate':
      if (!args.url && !args.macro) throw new Error('navigate 需要 url 或 macro')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/navigate`,
        body: {
          userId,
          ...(args.macro ? { macro: args.macro, query: args.query || '' } : { url: args.url }),
        },
        kind: 'json',
      }

    case 'scroll':
      return {
        method: 'POST',
        path: `/tabs/${tab()}/scroll`,
        body: { userId, direction: args.direction || 'down', ...(args.amount ? { amount: Number(args.amount) } : {}) },
        kind: 'json',
      }

    case 'screenshot':
      // kind='image'：拿二进制自己落盘，绝不进上下文。
      return { method: 'GET', path: `/tabs/${tab()}/screenshot?${q()}`, kind: 'image' }

    case 'links':
      return { method: 'GET', path: `/tabs/${tab()}/links?${q()}`, kind: 'json' }

    case 'evaluate':
      if (!args.expression) throw new Error('evaluate 需要 expression')
      return {
        method: 'POST',
        path: `/tabs/${tab()}/evaluate`,
        body: { userId, expression: args.expression },
        kind: 'json',
      }

    case 'text':
      // 读文章用这个：innerText 比 a11y 快照省得多，也不需要模型理解 e1/e2 引用。
      return {
        method: 'POST',
        path: `/tabs/${tab()}/evaluate`,
        body: {
          userId,
          expression: '(() => { const t = document.body ? document.body.innerText : ""; return { title: document.title, url: location.href, text: t }; })()',
        },
        kind: 'json',
      }

    case 'tabs':
      return { method: 'GET', path: `/tabs?${q()}`, kind: 'json' }

    case 'close':
      return { method: 'DELETE', path: `/tabs/${tab()}?${q()}`, kind: 'json' }

    case 'reset':
      // 关掉该 userId 的所有标签并清掉持久化的 cookie/localStorage。
      return { method: 'DELETE', path: `/sessions/${encodeURIComponent(userId)}`, kind: 'json' }

    case 'transcript': {
      if (!args.url) throw new Error('transcript 需要 url（YouTube 视频地址）')
      return {
        method: 'POST',
        path: '/youtube/transcript',
        body: { url: args.url, ...(args.languages ? { languages: args.languages } : {}) },
        kind: 'json',
      }
    }

    default:
      throw new Error(
        `未知 action：${(args && args.action) || '(空)'}。可用：` +
          'open/snapshot/text/click/type/press/navigate/scroll/screenshot/links/evaluate/tabs/close/reset/transcript',
      )
  }
}

/** 把 REST 的 JSON 结果压成一段给模型看的文本。 */
export function shapeResult(action, payload, opts = DEFAULTS) {
  if (payload === null || payload === undefined) return '(空响应)'
  if (typeof payload === 'string') return clip(payload, opts.maxChars)

  if (action === 'text' && payload && typeof payload === 'object' && 'text' in payload) {
    const head = payload.title ? `标题：${payload.title}\nURL：${payload.url}\n\n` : ''
    return clip(head + String(payload.text || ''), opts.maxChars)
  }

  if (action === 'snapshot') {
    const snap = payload.snapshot ?? payload
    const extra = []
    if (payload && payload.hasMore) extra.push(`（还有更多内容：用 offset=${payload.nextOffset} 继续）`)
    if (payload && payload.url) extra.push(`URL：${payload.url}`)
    const text = typeof snap === 'string' ? snap : JSON.stringify(snap, null, 2)
    return clip([...extra, text].join('\n'), opts.maxChars)
  }

  if (action === 'transcript' && payload && payload.transcript) {
    return clip(
      [payload.video_title ? `标题：${payload.video_title}` : '', payload.transcript].filter(Boolean).join('\n\n'),
      opts.maxChars,
    )
  }

  return clip(JSON.stringify(payload, null, 2), opts.maxChars)
}

/** 单次 HTTP 调用；把非 2xx 的响应体带出来，因为 camofox 的失败原因都在里面。 */
async function api(opts, call, signal) {
  const url = `${opts.baseUrl}${call.path}`
  const res = await fetch(url, {
    method: call.method,
    headers: { 'Content-Type': 'application/json' },
    body: call.body ? JSON.stringify(call.body) : undefined,
    signal,
  })
  if (!res.ok) {
    const detail = clip(await res.text().catch(() => ''), 4000)
    throw new Error(`camofox ${call.method} ${call.path} 失败：HTTP ${res.status}${detail ? `\n${detail}` : ''}`)
  }
  return call.kind === 'image' ? Buffer.from(await res.arrayBuffer()) : res.json()
}

/** 服务是否已经在跑（1.5 秒内没回应就当没跑）。 */
async function ping(opts) {
  try {
    const res = await fetch(`${opts.baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 服务生命周期。DSH 常驻一个 40MB 的 node 进程是可以接受的（camofox 自己会在
 * 5 分钟空闲后把浏览器关掉），但「装完插件就常驻」不行 —— 所以是懒启动：
 * 第一次真正调用工具时才 spawn，之后复用同一个子进程，插件卸载时带走。
 */
function createServerManager(opts, logger) {
  let child = null
  let starting = null
  const recent = []

  function remember(line) {
    recent.push(line)
    if (recent.length > 40) recent.shift()
  }

  function spawnServer() {
    if (!opts.serverDir || !existsSync(join(opts.serverDir, 'server.js'))) {
      throw new Error(
        `找不到 camofox-browser 服务：${join(opts.serverDir || '(未配置)', 'server.js')}。` +
          '请先 `git clone https://github.com/jo-inc/camofox-browser` 并 npm install，' +
          '再把插件配置里的 serverDir 指过去。',
      )
    }
    const env = {
      ...process.env,
      ...CAMOFOX_ENV,
      ...(opts.installDir ? { CAMOUFOX_INSTALL_DIR: opts.installDir } : {}),
      ...(opts.tempDir ? { TEMP: opts.tempDir, TMP: opts.tempDir } : {}),
      ...(opts.proxy && opts.proxy.enabled
        ? {
            PROXY_HOST: String(opts.proxy.host),
            PROXY_PORT: String(opts.proxy.port),
            ...(opts.proxy.protocol ? { PROXY_PROTOCOL: String(opts.proxy.protocol) } : {}),
            ...(opts.proxy.username ? { PROXY_USERNAME: String(opts.proxy.username) } : {}),
            ...(opts.proxy.password ? { PROXY_PASSWORD: String(opts.proxy.password) } : {}),
          }
        : {}),
      ...opts.env,
    }
    const proc = spawn(opts.nodePath || process.execPath, ['server.js'], {
      cwd: opts.serverDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.stderr.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.on('exit', (code) => {
      remember(`[camofox 服务退出] code=${code}`)
      if (child === proc) child = null
    })
    child = proc
    return proc
  }

  async function ensure() {
    if (await ping(opts)) return
    if (!opts.autoStart) {
      throw new Error(`camofox 服务没有在 ${opts.baseUrl} 上运行，且插件配置 autoStart=false（请手动 npm start）。`)
    }
    if (starting) return starting
    starting = (async () => {
      logger?.info?.(`[camofox] 拉起后端服务：${opts.serverDir}`)
      spawnServer()
      const deadline = Date.now() + Number(opts.startTimeoutMs || 120000)
      while (Date.now() < deadline) {
        if (child === null) {
          throw new Error(`camofox 服务启动即退出。最近输出：\n${recent.join('\n')}`)
        }
        if (await ping(opts)) return
        await new Promise((r) => setTimeout(r, 700))
      }
      throw new Error(`camofox 服务 ${opts.startTimeoutMs}ms 内没有就绪。最近输出：\n${recent.join('\n')}`)
    })().finally(() => {
      starting = null
    })
    return starting
  }

  function dispose() {
    if (child) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      child = null
    }
  }

  return { ensure, dispose, tail: () => recent.slice(-15).join('\n') }
}

/** 截图落盘 —— 图片从不进上下文；要看图由 DSH 的 read_image 读这个路径。 */
function saveShot(buffer, opts, tag) {
  const dir = opts.screenshotDir && existsSync(opts.screenshotDir) ? opts.screenshotDir : opts.screenshotDir
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `camofox-${tag || 'shot'}-${stamp}.png`)
  writeFileSync(file, buffer)
  return file
}

const ACTIONS = [
  'open', 'snapshot', 'text', 'click', 'type', 'press', 'navigate',
  'scroll', 'screenshot', 'links', 'evaluate', 'tabs', 'close', 'reset', 'transcript',
]

function camofoxTool(opts, manager) {
  return {
    name: 'camofox',
    description:
      '反检测浏览器（camofox-browser / Camoufox）—— 需要真实浏览器、且目标站点有反爬/风控或 Cloudflare 时首选它，' +
      '它比普通无头浏览器更难被识破。' +
      'action=open 开标签页拿 tabId；snapshot 取可交互元素树（元素带 e1/e2 引用，供 click/type 用）；' +
      'text 直接取正文纯文本（读文章、查资料最省）；click/type/press/navigate/scroll 做交互；' +
      'screenshot 截图存盘并返回文件路径（不进上下文，需要看图再用 read_image）；' +
      'evaluate 在页面里执行 JS；links 取页面链接；tabs/close/reset 管标签页与会话；' +
      'transcript 用 yt-dlp 抓 YouTube 字幕（无需 API key）。' +
      'navigate 支持搜索宏：' + SEARCH_MACROS.slice(0, 6).join('、') + ' 等 14 个。' +
      '首次调用会自动拉起本地 camofox 服务（冷启动约 3-8 秒）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作。' },
        tabId: { type: 'string', description: '标签页 id（open 返回；tabs 可列出）。' },
        url: { type: 'string', description: 'open/navigate/transcript：目标 URL。' },
        ref: { type: 'string', description: 'click/type：快照里的元素引用，如 e1。' },
        selector: { type: 'string', description: 'click/type：CSS 选择器（替代 ref）。' },
        text: { type: 'string', description: 'type：要输入的文本。' },
        pressEnter: { type: 'boolean', description: 'type：输入后是否回车。' },
        key: { type: 'string', description: 'press：按键名，如 Enter / Escape / Tab。' },
        macro: { type: 'string', enum: SEARCH_MACROS, description: 'navigate：搜索宏。' },
        query: { type: 'string', description: 'navigate：配合 macro 的搜索词。' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll：方向，默认 down。' },
        amount: { type: 'number', description: 'scroll：滚动像素。' },
        expression: { type: 'string', description: 'evaluate：在页面上下文执行的 JS 表达式。' },
        offset: { type: 'number', description: 'snapshot：大页面分页偏移（用上次返回的 nextOffset）。' },
        languages: { type: 'array', items: { type: 'string' }, description: 'transcript：字幕语言优先级，如 ["zh-Hans","en"]。' },
        sessionKey: { type: 'string', description: '标签页分组名（同组共享会话上下文），默认 default。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, imagePath: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: String((value && value.text) || '') }]
        return blocks
      },
    },
    presentCall(args) {
      const action = String((args && args.action) || '').trim()
      return { card: 'terminal', title: `camofox ${action}`.trim() }
    },
    presentResult(args, result) {
      try {
        const text = ((result && result.content) || [])
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        return {
          card: 'terminal',
          title: `camofox ${String((args && args.action) || '').trim()}`.trim(),
          output: text,
          exitCode: result && result.isError ? 1 : 0,
        }
      } catch {
        return undefined
      }
    },
    async execute(args, exec) {
      const action = String((args && args.action) || '').toLowerCase()
      const call = buildCall(args, opts)
      await manager.ensure()
      const signal = exec && exec.signal
        ? AbortSignal.any([exec.signal, AbortSignal.timeout(Number(opts.requestTimeoutMs) || 90000)])
        : AbortSignal.timeout(Number(opts.requestTimeoutMs) || 90000)
      let payload
      try {
        payload = await api(opts, call, signal)
      } catch (error) {
        const message = String((error && error.message) || error)
        // 带上服务最近输出：冷启动失败/引擎缺失的线索都在那里。
        throw new Error(`${message}\n\n[camofox 服务最近输出]\n${manager.tail()}`)
      }

      if (call.kind === 'image') {
        const file = saveShot(payload, opts, action)
        return { text: `截图已保存：${file}\n（要看图请用 read_image 读这个路径；图片不进上下文以免占用 token）`, imagePath: file }
      }

      // camofox 的 /evaluate 把返回值包在 {ok, result} 里。text 靠 evaluate 取正文，
      // 不脱壳的话 shapeResult 认不出 title/text，会退化成整段 JSON dump（还会被
      // maxChars 从中间截断）。其余 action 的响应本来就是扁平的，这个判断不会误伤。
      if (payload && typeof payload === 'object' && payload.ok === true && 'result' in payload) {
        payload = payload.result
      }

      // open 的结果里把 tabId 顶到最前面，模型下一步就能直接用。
      if (action === 'open' && payload && typeof payload === 'object' && payload.tabId) {
        return { text: `tabId: ${payload.tabId}\n${shapeResult(action, payload, opts)}` }
      }
      return { text: shapeResult(action, payload, opts) }
    },
  }
}

/** 宿主插件入口：一个工具 + 一个被托管的服务进程。 */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  opts.proxy = { ...DEFAULTS.proxy, ...(cfg.proxy || {}) }
  opts.env = { ...(DEFAULTS.env || {}), ...(cfg.env || {}) }

  const manager = createServerManager(opts, ctx.logger)

  ctx.inject(['tools'], (scoped) => {
    const dispose = scoped.tools.register(camofoxTool(opts, manager))
    ctx.on('dispose', () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* already gone */
      }
      manager.dispose()
    })
  })
}

export { apply, DEFAULTS, CAMOFOX_ENV, SEARCH_MACROS, clip, ping, createServerManager }
