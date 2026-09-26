/*!
 * Advertema AI — website chat widget
 *
 * <script src="https://YOUR-APP/widget.js"
 *         data-webhook="https://YOUR-APP/api/webhook/website/CHANNEL_ID"
 *         data-lang="ar"            (optional: ar | en — defaults to the page language)
 *         data-color="#7c3aed"      (optional: accent color)
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
    console.warn('[Advertema] Missing data-webhook attribute on widget script.')
    return
  }

  // Avoid mounting twice if the snippet is pasted more than once
  window.__advertemaWidgets = window.__advertemaWidgets || {}
  if (window.__advertemaWidgets[webhook]) return
  window.__advertemaWidgets[webhook] = true

  var pageLang = (document.documentElement.getAttribute('lang') || '').toLowerCase()
  var lang = script.getAttribute('data-lang') || (pageLang.indexOf('ar') === 0 ? 'ar' : 'en')
  if (lang !== 'ar' && lang !== 'en') lang = 'en'
  var color = script.getAttribute('data-color') || '#7c3aed'
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = '#7c3aed'
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
      powered: 'مدعوم من Advertema AI',
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
      powered: 'Powered by Advertema AI',
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

  var CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:inherit}' +
    '.root{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111827}' +
    '.bubble{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:' + color + ';color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.2);transition:transform .15s}' +
    '.bubble:hover{transform:scale(1.06)}' +
    '.bubble{position:relative}' +
    '.bubble.unread::after{content:"";position:absolute;top:2px;inset-inline-end:2px;width:12px;height:12px;border-radius:50%;background:#ef4444;border:2px solid #fff}' +
    '.bubble:focus-visible,.icon-btn:focus-visible,.send:focus-visible{outline:2px solid ' + color + ';outline-offset:2px}' +
    '.bubble svg{width:26px;height:26px}' +
    '.panel{position:absolute;bottom:72px;' + side + ':0;width:370px;max-width:calc(100vw - 40px);height:540px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden}' +
    '.panel[hidden]{display:none}' +
    '.header{background:' + color + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.title{font-weight:600;font-size:15px;margin:0}' +
    '.status{font-size:12px;opacity:.85;margin:0}' +
    '.icon-btn{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px;border-radius:6px;display:flex}' +
    '.icon-btn svg{width:20px;height:20px}' +
    '.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}' +
    '.msg{max-width:82%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}' +
    '.msg.user{align-self:flex-end;background:' + color + ';color:#fff;border-end-end-radius:4px}' +
    '.msg.assistant,.msg.agent{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-end-start-radius:4px}' +
    '.msg.notice{align-self:center;background:#fef2f2;color:#991b1b;font-size:13px;text-align:center}' +
    '.typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:12px 14px;display:flex;gap:4px}' +
    '.typing span{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:blink 1.2s infinite}' +
    '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
    '@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}' +
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}' +
    '.input{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 12px;font-size:14px;max-height:110px;outline:none;color:#111827;background:#fff}' +
    '.input:focus{border-color:' + color + '}' +
    '.send{border:0;border-radius:10px;background:' + color + ';color:#fff;padding:0 14px;cursor:pointer;display:flex;align-items:center}' +
    '.send:disabled{opacity:.5;cursor:default}' +
    '.send svg{width:18px;height:18px}' +
    '[dir=rtl] .send svg{transform:scaleX(-1)}' +
    '.footer{text-align:center;font-size:11px;color:#9ca3af;padding:0 0 8px;background:#fff}' +
    '@media (max-width:480px){.root{bottom:12px;' + side + ':12px}.panel{width:calc(100vw - 24px);max-width:none;height:calc(100vh - 100px)}}'

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
    var headText = el('div')
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
          console.warn('[Advertema] Chat channel is not available:', info && info.error)
          return
        }
        mount(info)
      })
      .catch(function (err) {
        console.warn('[Advertema] Could not reach chat server.', err)
      })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
