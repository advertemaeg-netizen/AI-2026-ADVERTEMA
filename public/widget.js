/*!
 * Mudrik AI — website chat widget
 *
 * <script src="https://YOUR-APP/widget.js"
 *         data-webhook="https://YOUR-APP/api/webhook/website/CHANNEL_ID"
 *         data-lang="ar"            (optional: ar | en — defaults to the page language)
 *         data-color="#933703"      (optional: accent color)
 *         data-position="right"     (optional: right | left)
 *         data-title="..."          (optional: header title — defaults to the business name)
 *         async></script>
 */
(function () {
  'use strict'

  var script = document.currentScript
  if (!script) return
  var webhook = script.getAttribute('data-webhook')
  if (!webhook) {
    console.warn('[Mudrik] Missing data-webhook attribute on widget script.')
    return
  }

  // Avoid mounting twice if the snippet is pasted more than once
  window.__advertemaWidgets = window.__advertemaWidgets || {}
  if (window.__advertemaWidgets[webhook]) return
  window.__advertemaWidgets[webhook] = true

  var pageLang = (document.documentElement.getAttribute('lang') || '').toLowerCase()
  var lang = script.getAttribute('data-lang') || (pageLang.indexOf('ar') === 0 ? 'ar' : 'en')
  if (lang !== 'ar' && lang !== 'en') lang = 'en'
  var color = script.getAttribute('data-color') || '#933703'
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = '#933703'
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right'
  var customTitle = script.getAttribute('data-title')

  var TEXT = {
    ar: {
      open: 'افتح المحادثة',
      close: 'إغلاق',
      greeting: 'أهلاً بك! كيف يمكننا مساعدتك اليوم؟',
      placeholder: 'اكتب رسالتك...',
      send: 'إرسال',
      online: 'متصل الآن',
      error: 'حدثت مشكلة في الاتصال. حاول مرة أخرى بعد قليل.',
      busy: 'أرسلت رسائل كثيرة بسرعة. انتظر دقيقة ثم حاول مرة أخرى.',
      unavailable: 'الخدمة غير متاحة حالياً. سيتواصل معك فريقنا قريباً.',
      powered: 'مدعوم من Mudrik AI',
    },
    en: {
      open: 'Open chat',
      close: 'Close',
      greeting: 'Hi there! How can we help you today?',
      placeholder: 'Type your message...',
      send: 'Send',
      online: 'Online now',
      error: 'Connection problem. Please try again in a moment.',
      busy: "You're sending messages too fast. Please wait a minute.",
      unavailable: 'Chat is unavailable right now. Our team will get back to you soon.',
      powered: 'Powered by Mudrik AI',
    },
  }[lang]

  var storageKey = 'advertema:' + webhook
  var MAX_STORED = 50

  function loadState() {
    try {
      var raw = window.localStorage.getItem(storageKey)
      if (raw) return JSON.parse(raw)
    } catch {
      // storage unavailable (private mode, blocked cookies) — run without persistence
    }
    return null
  }

  function saveState() {
    try {
      state.messages = state.messages.slice(-MAX_STORED)
      window.localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      // storage unavailable (private mode, blocked cookies) — run without persistence
    }
  }

  function randomId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
    var s = ''
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
    return s
  }

  var state = loadState() || { visitorId: randomId(), conversationId: null, messages: [] }
  if (!state.messages) state.messages = []

  // The widget's tokens: the dashboard's palette (app/globals.css), restated
  // here because this file runs on clients' sites, outside the app's CSS.
  // The accent is the client's data-color; the default is the action brown.
  var TOKENS =
    '--accent:' + color + ';--on-accent:#fff;' +
    '--surface:#fff;--canvas:#fcf9ea;--ink:#000;--muted:#6b6050;--border:#e8dfc7;--input:#b3a584;' +
    // Provisional, like the dashboard's: the previous red until the error tone is approved
    '--notice-bg:#fef2f2;--notice-ink:#991b1b;--unread:#ef4444;' +
    '--shadow:0 12px 32px -12px rgba(147,55,3,.3),0 2px 8px rgba(0,0,0,.08);' +
    '--fast:140ms;--base:220ms;--slow:360ms;--ease:cubic-bezier(.22,1,.36,1);--spring:cubic-bezier(.34,1.56,.64,1)'

  var CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:inherit}' +
    '.root{' + TOKENS + ';position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;font-size:14px;line-height:1.5;color:var(--ink)}' +
    '.bubble{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow);transition:transform var(--base) var(--spring)}' +
    '.bubble:hover{transform:scale(1.08)}' +
    '.bubble:active{transform:scale(.95)}' +
    '.bubble{position:relative}' +
    '.bubble.unread::after{content:"";position:absolute;top:2px;inset-inline-end:2px;width:12px;height:12px;border-radius:50%;background:var(--unread);border:2px solid var(--surface);animation:pop var(--base) var(--spring) both}' +
    '.bubble:focus-visible,.icon-btn:focus-visible,.send:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    '.bubble svg{width:26px;height:26px}' +
    '.panel{position:absolute;bottom:72px;' + side + ':0;width:370px;max-width:calc(100vw - 40px);height:540px;max-height:calc(100vh - 110px);background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom ' + side + ';animation:open var(--slow) var(--ease) both}' +
    '.panel[hidden]{display:none}' +
    '.header{background:var(--accent);color:var(--on-accent);padding:12px 16px;display:flex;align-items:center;gap:10px}' +
    '.mark{display:block;height:28px;width:46px;flex-shrink:0}' +
    '.head-text{flex:1;min-width:0}' +
    '.title{font-weight:700;font-size:15px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.status{font-size:12px;opacity:.85;margin:0}' +
    '.icon-btn{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px;border-radius:6px;display:flex;transition:background-color var(--fast)}' +
    '.icon-btn:hover{background:rgba(255,255,255,.15)}' +
    '.icon-btn svg{width:20px;height:20px}' +
    '.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:var(--canvas)}' +
    '.msg{max-width:82%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;animation:rise var(--base) var(--ease) both}' +
    '.msg.user{align-self:flex-end;background:var(--accent);color:var(--on-accent);border-end-end-radius:4px}' +
    '.msg.assistant,.msg.agent{align-self:flex-start;background:var(--surface);border:1px solid var(--border);border-end-start-radius:4px}' +
    '.msg.notice{align-self:center;background:var(--notice-bg);color:var(--notice-ink);font-size:13px;text-align:center}' +
    '.typing{align-self:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;display:flex;gap:4px;animation:rise var(--base) var(--ease) both}' +
    '.typing span{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:blink 1.2s infinite}' +
    '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
    '@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}' +
    '@keyframes open{from{opacity:0;transform:translateY(12px) scale(.96)}}' +
    '@keyframes rise{from{opacity:0;transform:translateY(6px)}}' +
    '@keyframes pop{from{opacity:0;transform:scale(.6)}}' +
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);background:var(--surface)}' +
    '.input{flex:1;resize:none;border:1px solid var(--input);border-radius:10px;padding:9px 12px;font-size:14px;max-height:110px;outline:none;color:var(--ink);background:var(--surface);transition:border-color var(--fast)}' +
    '.input:focus{border-color:var(--accent)}' +
    '.send{border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);padding:0 14px;cursor:pointer;display:flex;align-items:center;transition:transform var(--fast) var(--ease),opacity var(--fast)}' +
    '.send:not(:disabled):active{transform:scale(.94)}' +
    '.send:disabled{opacity:.5;cursor:default}' +
    '.send svg{width:18px;height:18px}' +
    '[dir=rtl] .send svg{transform:scaleX(-1)}' +
    '.footer{text-align:center;font-size:11px;color:var(--muted);padding:0 0 8px;background:var(--surface)}' +
    '@media (max-width:480px){.root{bottom:12px;' + side + ':12px}.panel{width:calc(100vw - 24px);max-width:none;height:calc(100vh - 100px)}}' +
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}'

  // public/brand/mudrik-mark.svg, inlined: a CSS mask pointing at our host
  // would be a cross-origin load from the client's site. 28px tall, never less.
  var MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1157.000000 700.000000" width="100%" height="100%" focusable="false"><g transform="translate(0.000000,700.000000) scale(0.100000,-0.100000)" fill="currentColor" stroke="none"><path d="M4128 6655 c-401 -50 -818 -202 -1088 -394 l-65 -46 855 -3 c767 -2 862 -1 925 14 39 9 82 23 97 30 22 11 117 14 500 14 404 0 470 2 453 14 -49 34 -230 128 -328 171 -208 90 -424 152 -664 191 -137 22 -543 28 -685 9z"/><path d="M2737 5988 c-36 -40 -140 -164 -231 -276 l-166 -203 1197 3 1198 3 65 23 c36 13 69 28 74 33 6 5 256 9 606 9 l596 0 129 136 129 136 -71 69 -71 69 -638 0 c-626 0 -640 0 -694 21 -123 47 -147 48 -1132 49 l-927 0 -64 -72z"/><path d="M7860 5894 c-414 -31 -793 -167 -1070 -384 -38 -30 -931 -938 -1984 -2016 -1053 -1079 -1949 -1992 -1993 -2029 -283 -243 -762 -468 -1123 -529 -136 -23 -276 -29 -405 -17 -66 7 -129 14 -140 17 -28 9 43 -48 140 -111 592 -388 1399 -337 1918 121 43 38 798 827 1677 1754 880 927 1617 1695 1638 1707 45 27 110 30 155 7 50 -27 463 -420 478 -457 17 -41 16 -104 -2 -140 -8 -15 -581 -626 -1274 -1358 -693 -731 -1278 -1350 -1299 -1375 l-39 -45 174 -176 c96 -96 206 -201 244 -232 527 -436 1346 -479 1885 -100 51 36 377 352 1005 974 512 507 962 950 1000 985 415 375 847 585 1320 641 125 15 401 6 515 -16 92 -17 202 -47 263 -71 29 -11 37 -11 31 -2 -29 48 -1686 2384 -1721 2425 -167 198 -533 358 -946 413 -88 11 -363 20 -447 14z"/><path d="M1993 5087 l-221 -272 1426 -3 c941 -2 1454 1 1506 8 44 5 104 21 134 35 54 25 58 25 316 25 l261 0 191 203 191 202 -436 5 -436 5 -75 33 -75 32 -1280 0 -1280 -1 -222 -272z"/><path d="M1429 4398 c-118 -145 -218 -269 -223 -275 -6 -10 344 -13 1736 -13 l1744 0 222 234 c122 129 222 237 222 240 0 3 -49 6 -108 6 -98 0 -116 3 -193 33 l-84 32 -1551 3 -1551 2 -214 -262z"/><path d="M895 3749 c-99 -121 -199 -245 -223 -275 l-44 -54 1704 0 1703 1 180 191 c99 105 215 228 258 274 l79 84 -1739 0 -1738 -1 -180 -220z"/><path d="M463 3183 c-69 -117 -124 -237 -162 -356 -17 -53 -31 -99 -31 -102 0 -3 699 -5 1553 -4 l1552 0 109 117 c60 64 177 188 259 275 l149 157 -1689 0 -1689 0 -51 -87z"/><path d="M10066 2709 c-170 -17 -400 -86 -556 -169 l-55 -29 127 -1 c123 0 129 -1 204 -35 l76 -35 546 0 545 0 -19 21 c-36 40 -184 131 -268 165 -116 47 -214 71 -347 83 -125 12 -126 12 -253 0z"/><path d="M244 2544 c-4 -14 -4 -63 -2 -108 7 -104 49 -229 111 -329 l46 -74 557 -6 c307 -4 826 -7 1155 -7 l597 0 262 275 261 275 -1490 0 -1491 0 -6 -26z"/><path d="M9750 2124 c-75 -38 -147 -44 -512 -44 l-346 0 -126 -132 -126 -133 508 -6 c354 -4 521 -9 552 -18 25 -6 74 -21 109 -31 60 -19 98 -20 776 -20 l713 0 -5 43 c-9 87 -36 195 -70 280 l-35 87 -697 -1 -696 -2 -45 -23z"/><path d="M590 1830 c89 -78 217 -163 325 -215 207 -100 373 -138 595 -138 230 0 400 44 655 168 115 56 304 171 345 211 12 12 -119 14 -975 14 l-990 -1 45 -39z"/><path d="M9860 1445 c-30 -7 -77 -23 -103 -34 -48 -21 -62 -21 -782 -21 l-733 0 -126 -132 -126 -133 863 -5 c849 -5 863 -5 907 -26 104 -48 118 -49 720 -46 509 3 567 5 584 20 57 52 163 246 201 370 l6 22 -678 -1 c-531 0 -690 -4 -733 -14z"/><path d="M9830 751 c-8 -5 -44 -20 -80 -33 l-65 -23 -690 -5 -690 -5 85 -54 c326 -210 686 -313 1085 -313 334 0 612 62 900 202 105 51 281 159 355 219 l25 21 -455 -1 c-250 0 -462 -4 -470 -8z"/></g></svg>'

  var ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  var ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  var ICON_SEND =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>'

  function el(tag, className, attrs) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k])
    return node
  }

  function mount(info) {
    var host = el('div', null, { id: 'advertema-chat-widget' })
    var shadow = host.attachShadow({ mode: 'open' })
    var style = el('style')
    style.textContent = CSS
    shadow.appendChild(style)

    var root = el('div', 'root', { dir: lang === 'ar' ? 'rtl' : 'ltr', lang: lang })

    var panel = el('div', 'panel', { role: 'dialog', 'aria-label': customTitle || info.client.name })
    panel.hidden = true

    var header = el('div', 'header')
    var mark = el('span', 'mark', { 'aria-hidden': 'true' })
    mark.innerHTML = MARK_SVG
    header.appendChild(mark)
    var headText = el('div', 'head-text')
    var title = el('p', 'title')
    title.textContent = customTitle || info.client.name
    var status = el('p', 'status')
    status.textContent = TEXT.online
    headText.appendChild(title)
    headText.appendChild(status)
    var closeBtn = el('button', 'icon-btn', { type: 'button', 'aria-label': TEXT.close })
    closeBtn.innerHTML = ICON_CLOSE
    header.appendChild(headText)
    header.appendChild(closeBtn)

    var list = el('div', 'messages', { role: 'log', 'aria-live': 'polite' })

    var form = el('form', 'form')
    var input = el('textarea', 'input', { rows: '1', placeholder: TEXT.placeholder, 'aria-label': TEXT.placeholder, maxlength: '2000' })
    var sendBtn = el('button', 'send', { type: 'submit', 'aria-label': TEXT.send })
    sendBtn.innerHTML = ICON_SEND
    form.appendChild(input)
    form.appendChild(sendBtn)

    var footer = el('div', 'footer')
    footer.textContent = TEXT.powered

    panel.appendChild(header)
    panel.appendChild(list)
    panel.appendChild(form)
    panel.appendChild(footer)

    var bubble = el('button', 'bubble', { type: 'button', 'aria-label': TEXT.open, 'aria-expanded': 'false' })
    bubble.innerHTML = ICON_CHAT

    root.appendChild(panel)
    root.appendChild(bubble)
    shadow.appendChild(root)
    document.body.appendChild(host)

    var typing = null
    var sending = false

    function addMessage(role, content) {
      var node = el('div', 'msg ' + role)
      node.textContent = content // textContent keeps replies from injecting HTML
      list.appendChild(node)
      list.scrollTop = list.scrollHeight
    }

    function setTyping(on) {
      if (on && !typing) {
        typing = el('div', 'typing', { 'aria-hidden': 'true' })
        typing.appendChild(el('span'))
        typing.appendChild(el('span'))
        typing.appendChild(el('span'))
        list.appendChild(typing)
        list.scrollTop = list.scrollHeight
      } else if (!on && typing) {
        typing.remove()
        typing = null
      }
    }

    // The client's configured welcome message, if the server sent one
    addMessage('assistant', info.welcomeMessage || TEXT.greeting)
    for (var i = 0; i < state.messages.length; i++) {
      addMessage(state.messages[i].role, state.messages[i].content)
    }

    // Human agents reply from the dashboard asynchronously. A DB trigger
    // broadcasts each agent message over Supabase Realtime to a topic only this
    // visitor knows (conversation id + their random visitor id).
    function showAgentMessage(m) {
      if (!m || !m.id) return
      state.seenAgent = state.seenAgent || []
      if (m.created_at && (!state.agentCursor || m.created_at > state.agentCursor)) {
        state.agentCursor = m.created_at
      }
      if (state.seenAgent.indexOf(m.id) !== -1) return
      state.seenAgent.push(m.id)
      state.seenAgent = state.seenAgent.slice(-100)
      addMessage('agent', m.content)
      state.messages.push({ role: 'agent', content: m.content })
      if (panel.hidden) bubble.classList.add('unread')
      saveState()
    }

    // One-off catch-up for replies sent while this visitor was disconnected
    function syncMissedReplies() {
      if (!state.conversationId) return
      var url =
        webhook +
        (webhook.indexOf('?') === -1 ? '?' : '&') +
        'conversationId=' + encodeURIComponent(state.conversationId) +
        '&visitorId=' + encodeURIComponent(state.visitorId) +
        (state.agentCursor ? '&after=' + encodeURIComponent(state.agentCursor) : '')
      fetch(url)
        .then(function (res) {
          return res.json()
        })
        .then(function (data) {
          if (!data || !data.ok || !data.messages) return
          for (var j = 0; j < data.messages.length; j++) showAgentMessage(data.messages[j])
        })
        .catch(function () {})
    }

    // Minimal Phoenix-protocol client for Supabase Realtime broadcast, so the
    // widget doesn't have to ship supabase-js
    var socket = null
    var socketTopic = null
    var heartbeat = null
    var reconnectDelay = 1000
    var ref = 0

    function send(ws, message) {
      ref += 1
      message.ref = String(ref)
      ws.send(JSON.stringify(message))
    }

    function connectRealtime() {
      var rt = info.realtime
      if (!rt || !rt.url || !rt.apiKey || !state.conversationId || !window.WebSocket) return
      var topic = 'realtime:widget:' + state.conversationId + ':' + state.visitorId
      if (socket && socketTopic === topic) return
      if (socket) socket.close()

      var ws = new WebSocket(rt.url + '?apikey=' + encodeURIComponent(rt.apiKey) + '&vsn=1.0.0')
      socket = ws
      socketTopic = topic

      ws.onopen = function () {
        reconnectDelay = 1000
        send(ws, {
          topic: topic,
          event: 'phx_join',
          payload: { config: { broadcast: { self: false }, presence: { key: '' }, private: false } },
        })
        clearInterval(heartbeat)
        heartbeat = setInterval(function () {
          if (ws.readyState === 1) send(ws, { topic: 'phoenix', event: 'heartbeat', payload: {} })
        }, 25000)
        syncMissedReplies()
      }

      ws.onmessage = function (e) {
        var msg
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (msg.topic === topic && msg.event === 'broadcast' && msg.payload && msg.payload.event === 'agent_message') {
          showAgentMessage(msg.payload.payload)
        }
      }

      ws.onclose = function () {
        clearInterval(heartbeat)
        if (socket !== ws) return // replaced by a newer connection
        socket = null
        socketTopic = null
        setTimeout(connectRealtime, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      }
    }

    connectRealtime()

    function setOpen(open) {
      panel.hidden = !open
      if (open) bubble.classList.remove('unread')
      bubble.setAttribute('aria-expanded', String(open))
      bubble.innerHTML = open ? ICON_CLOSE : ICON_CHAT
      bubble.setAttribute('aria-label', open ? TEXT.close : TEXT.open)
      if (open) {
        list.scrollTop = list.scrollHeight
        input.focus()
      }
    }

    bubble.addEventListener('click', function () {
      setOpen(panel.hidden)
    })
    closeBtn.addEventListener('click', function () {
      setOpen(false)
      bubble.focus()
    })
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        setOpen(false)
        bubble.focus()
      }
    })

    input.addEventListener('input', function () {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 110) + 'px'
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        if (form.requestSubmit) form.requestSubmit()
        else form.dispatchEvent(new Event('submit', { cancelable: true }))
      }
    })

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var text = input.value.trim()
      if (!text || sending) return

      sending = true
      sendBtn.disabled = true
      input.value = ''
      input.style.height = 'auto'
      addMessage('user', text)
      state.messages.push({ role: 'user', content: text })
      saveState()
      setTyping(true)

      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          visitorId: state.visitorId,
          conversationId: state.conversationId,
        }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: false }
          })
        })
        .then(function (data) {
          if (data.conversationId && data.conversationId !== state.conversationId) {
            state.conversationId = data.conversationId
            connectRealtime()
          }
          if (data.ok) {
            // reply is null once a human agent has taken over the chat
            if (data.reply) {
              addMessage('assistant', data.reply)
              state.messages.push({ role: 'assistant', content: data.reply })
            }
          } else if (data.error === 'rate_limited') {
            addMessage('notice', TEXT.busy)
          } else if (data.error === 'limit_reached' || data.error === 'inactive' || data.error === 'ai_unavailable') {
            addMessage('notice', TEXT.unavailable)
          } else {
            addMessage('notice', TEXT.error)
          }
          saveState()
        })
        .catch(function () {
          addMessage('notice', TEXT.error)
        })
        .then(function () {
          setTyping(false)
          sending = false
          sendBtn.disabled = false
          input.focus()
        })
    })
  }

  function start() {
    fetch(webhook, { method: 'GET' })
      .then(function (res) {
        return res.json()
      })
      .then(function (info) {
        if (!info || !info.ok) {
          console.warn('[Mudrik] Chat channel is not available:', info && info.error)
          return
        }
        mount(info)
      })
      .catch(function (err) {
        console.warn('[Mudrik] Could not reach chat server.', err)
      })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
