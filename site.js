/* Margyn site: shared motion + page modules. Every module checks its element exists, so one file serves every page. */
(function(){
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const wait = ms => new Promise(r => setTimeout(r, RM ? 0 : ms));
  const once = (el, fn, opts) => {
    if(!el) return;
    if(!('IntersectionObserver' in window)){ fn(); return; }
    const io = new IntersectionObserver(es => es.forEach(e => { if(e.isIntersecting){ fn(); io.disconnect(); } }), opts || { threshold:0.25 });
    io.observe(el);
  };
  // live visibility flag, so loops pause off screen
  const watch = (el, th) => { const st = { on:!('IntersectionObserver' in window) }; if(el && !st.on) new IntersectionObserver(([e]) => { st.on = e.isIntersecting; }, { threshold:th || 0.3 }).observe(el); return st; };
  const until = st => new Promise(res => (function chk(){ st.on && !document.hidden ? res() : setTimeout(chk, 300); })());

  // ---------- scale fixed-width product replicas to their container ----------
  function fitAll(){
    const sm = window.matchMedia('(max-width:900px)').matches;
    $$('.fit').forEach(f => { const w = +((sm && f.dataset.wSm) || f.dataset.w); f.style.setProperty('--s', Math.min(f.dataset.max ? +f.dataset.max : 1.18, f.clientWidth / w)); });
  }
  fitAll(); window.addEventListener('resize', fitAll);

  // ---------- nav ----------
  const nav = $('#nav');
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;height:8px;width:1px';
  document.body.prepend(sentinel);
  if(nav) new IntersectionObserver(([e]) => nav.classList.toggle('scrolled', !e.isIntersecting)).observe(sentinel);

  // ---------- reveal ----------
  const rv = $$('.reveal');
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver(es => es.forEach(en => { if(en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin:'0px 0px -8% 0px' });
    rv.forEach(e => io.observe(e));
  } else rv.forEach(e => e.classList.add('in'));

  // ---------- headings: each word slides up out of its own mask ----------
  (function(){
    function split(node, n){
      [...node.childNodes].forEach(c => {
        if(c.nodeType === 3){
          const frag = document.createDocumentFragment();
          c.textContent.split(/(\s+)/).forEach(p => {
            if(!p) return;
            if(/^\s+$/.test(p)){ frag.appendChild(document.createTextNode(p)); return; }
            const w = document.createElement('span'), i = document.createElement('i');
            w.className = 'w'; w.style.setProperty('--i', n.i++); i.textContent = p; w.appendChild(i); frag.appendChild(w);
          });
          c.replaceWith(frag);
        } else if(c.nodeType === 1) split(c, n);
      });
    }
    $$('h2.h').forEach(h => {
      h.setAttribute('aria-label', h.textContent.replace(/\s+/g, ' ').trim());
      split(h, { i:0 });
      if(RM || !('IntersectionObserver' in window)){ h.classList.add('words-in'); return; }
      const io = new IntersectionObserver(([e]) => { if(e.isIntersecting){ h.classList.add('words-in'); io.disconnect(); } }, { rootMargin:'0px 0px -10% 0px' });
      io.observe(h);
    });
  })();

  // ---------- count-up ----------
  function countUp(el){
    if(!el) return;
    const to = +el.dataset.count, dp = +(el.dataset.dp || 0), pre = el.dataset.pre || '', suf = el.dataset.suf || '';
    if(RM){ el.textContent = pre + to.toFixed(dp) + suf; return; }
    const t0 = performance.now(), dur = +(el.dataset.dur || 1300);
    (function tick(t){
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = pre + (to * e).toFixed(dp) + suf;
      if(k < 1) requestAnimationFrame(tick);
    })(t0);
  }
  $$('[data-count-on-view]').forEach(el => once(el, () => countUp(el), { threshold:0.6 }));

  // ---------- typewriter (word by word) ----------
  function typeWords(el, ms){
    return new Promise(res => {
      const txt = el.dataset.text;
      if(RM){ el.textContent = txt; res(); return; }
      const words = txt.split(' '); let i = 0;
      el.textContent = ''; el.classList.add('typing-caret');
      (function step(){
        el.textContent = words.slice(0, ++i).join(' ');
        if(i < words.length) setTimeout(step, (ms || 45) + Math.random() * (ms || 45) * 0.8);
        else { el.classList.remove('typing-caret'); res(); }
      })();
    });
  }
  // character by character, for the composer
  function typeChars(el, txt, ms){
    return new Promise(res => {
      if(RM){ el.textContent = txt; res(); return; }
      let i = 0; el.textContent = '';
      (function step(){ el.textContent = txt.slice(0, ++i); if(i < txt.length) setTimeout(step, ms + Math.random() * ms); else res(); })();
    });
  }

  // ---------- forecast chart ----------
  const FC = [1.84, 1.30, 1.02, 1.49, 1.49, 1.47, 1.63, 1.66, 1.76, 1.53, 1.56, 1.59, 1.62, 1.41];
  function drawChart(svg){
    const vb = svg.viewBox.baseVal, W = vb.width, H = vb.height, L = 58, R = 8, T = 12, B = 22, max = 2.0;
    const x = i => L + i * (W - L - R) / (FC.length - 1), y = v => T + (1 - v / max) * (H - T - B);
    const d = FC.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    let g = '';
    [0, 1, 2].forEach(v => { g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="4" y="${y(v) + 3}">${v ? '₹' + v + '.0 Cr' : '0'}</text>`; });
    [1, 3, 5, 7, 9, 11, 13].forEach(i => { g += `<text x="${x(i) - 8}" y="${H - 6}">W${i}</text>`; });
    g += `<path class="area" d="${d}L${x(FC.length - 1)},${y(0)}L${L},${y(0)}Z"/>`;
    g += `<line class="floor" x1="${L}" x2="${W - R}" y1="${y(1.19)}" y2="${y(1.19)}"/>`;
    g += `<path class="line" d="${d}"/><circle class="lowdot" cx="${x(2)}" cy="${y(1.02)}" r="4"/>`;
    svg.innerHTML = g;
    const line = svg.querySelector('.line'); svg.style.setProperty('--len', Math.ceil(line.getTotalLength() * 1.6));
  }
  $$('svg[data-chart]').forEach(drawChart);

  // ---------- HOME hero: product settles flat as you scroll, figures count, briefing types ----------
  (function(){
    const app = $('#heroApp'); if(!app) return;
    setTimeout(() => { $$('[data-count]', app).forEach(countUp); const c = $('#heroChart'); c && c.classList.add('drawn'); }, RM ? 0 : 500);
    const tilt = $('#tilt');
    if(tilt && !(window.CSS && CSS.supports('animation-timeline: scroll()'))){
      if(RM) tilt.style.setProperty('--t', 0);
      else { let tk = false; const upd = () => { tilt.style.setProperty('--t', Math.max(0, 1 - window.scrollY / 380).toFixed(3)); tk = false; };
        upd(); window.addEventListener('scroll', () => { if(!tk){ tk = true; requestAnimationFrame(upd); } }, { passive:true }); }
    }
    const rot = $('#rot');
    if(rot && !RM){
      const words = ['for collections.', 'for your cash.', 'for GST.', 'for month end.', 'that never sleeps.']; let i = 0;
      setInterval(() => {
        if(document.hidden) return;
        i = (i + 1) % words.length;
        const old = rot.querySelector('.rot-w:not(.out)'), w = document.createElement('span');
        w.className = 'rot-w in'; w.textContent = words[i];
        rot.style.width = rot.offsetWidth + 'px'; old.classList.add('out'); setTimeout(() => old.remove(), 460);
        rot.appendChild(w); requestAnimationFrame(() => { rot.style.width = w.offsetWidth + 'px'; });
      }, 2600);
    }
    const b = $('#heroBrief'); if(b) setTimeout(() => typeWords(b, 38), RM ? 0 : 1300);
  })();

  // ---------- HOME hero (Ramp method): one scene scaled to the canvas, a 14s story on loop ----------
  (function(){
    const cv = $('#rhCanvas'), sc = $('#rhScene'); if(!cv || !sc) return;
    const fit = () => { const s = window.matchMedia('(max-width:860px)').matches ? 1 : Math.min(1, cv.clientWidth / 1232); cv.style.setProperty('--hs', s.toFixed(4)); };
    fit(); window.addEventListener('resize', fit);
    const steps = $$('.wm[data-step]', sc), send = $('#rhSend'), kav = $('#rx-kav');
    const st = $('.rx-st', kav), rp = $('.rx-rp', kav);
    const K = { cash:$('#rhCash'), over:$('#rhOver'), coll:$('#rhColl') };
    const START = { st:st.innerHTML, rp:rp.innerHTML, cash:K.cash.textContent, over:K.over.textContent, coll:K.coll.textContent };
    const put = (el, html) => { el.innerHTML = html; el.firstElementChild && el.firstElementChild.classList.add('swap'); };
    const tween = (el, from, to, fmt, ms) => new Promise(res => {
      el.classList.add('bump'); const t0 = performance.now();
      (function f(t){ const p = Math.max(0, Math.min(1, (t - t0) / ms)), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(from + (to - from) * e); p < 1 ? requestAnimationFrame(f) : res(); })(t0);
    });
    const cr = v => '₹' + v.toFixed(2) + ' Cr', lk = v => '₹' + v.toFixed(1) + ' L';
    const show = n => steps[n - 1].classList.add('on');
    const finalState = () => { steps.forEach(s => s.classList.add('on')); kav.classList.add('live'); st.innerHTML = '<span class="chip ok">Matched</span>'; rp.textContent = 'Paid today'; K.cash.textContent = '₹2.04 Cr'; K.over.textContent = '₹68.6 L'; K.coll.textContent = '₹34.8 L'; };
    if(RM){ finalState(); return; }
    const on = watch(cv, 0.2);
    (async function loop(){
      for(;;){
        await until(on); await wait(1600);
        send.classList.add('tap'); kav.classList.add('live'); await wait(450);
        show(1); await wait(900);
        show(2); put(st, '<span class="chip blue">Reminder sent</span>'); await wait(2600);
        show(3); put(rp, '<span>Paid today</span>'); put(st, '<span class="chip ok">Matched</span>');
        await Promise.all([tween(K.cash, 1.84, 2.038, cr, 1100), tween(K.over, 88.4, 68.6, lk, 1100), tween(K.coll, 15.0, 34.8, lk, 1100)]);
        await wait(5200);
        sc.classList.add('reset'); await wait(550);
        steps.forEach(s => s.classList.remove('on')); send.classList.remove('tap'); kav.classList.remove('live');
        st.innerHTML = START.st; rp.innerHTML = START.rp; Object.keys(K).forEach(k => { K[k].textContent = START[k]; K[k].classList.remove('bump'); });
        sc.classList.remove('reset');
      }
    })();
  })();

  // ---------- HOME how it works: three systems talk, the gap becomes an Inbox card ----------
  (function(){
    const tk = $('#talk'), steps = $$('#steps .step'); if(!tk || !steps.length) return;
    const rows = $$('.tk-row:not(.tk-m)', tk), m = $('#tkM'), links = $$('.tk-links path', tk), dots = $$('.tk-links circle', tk);
    const DUR = [3000, 4800, 6200];
    let cur = 0, start = 0, run = 0;
    const vis = watch(tk, 0.35);
    function reset(){
      tk.classList.remove('synced', 'clicked');
      [...rows, m].forEach(r => r.classList.remove('fill', 'ok', 'gap'));
      links.forEach(l => l.classList.remove('on')); dots.forEach(d => d.classList.remove('on'));
    }
    function fillRow(r, k){ r.classList.add('fill'); setTimeout(() => {
      $$('.tk-links [data-r="' + k + '"]', tk).forEach(el => { el.classList.remove('on'); void el.getBoundingClientRect(); el.classList.add('on'); });
      setTimeout(() => r.classList.add(r === m ? 'gap' : 'ok'), RM ? 0 : 420);
    }, RM ? 0 : 250); }
    async function phase(p){
      const id = ++run; cur = p; start = performance.now(); tk.dataset.p = p;
      steps.forEach((b, i) => { b.classList.toggle('on', i === p); b.setAttribute('aria-selected', i === p); b.style.setProperty('--p', 0); });
      if(p === 0){ reset(); await wait(1400); if(id !== run) return; tk.classList.add('synced'); }
      if(p === 1){ reset(); tk.classList.add('synced');
        const all = [...rows, m];
        for(let k = 0; k < all.length; k++){ if(id !== run) return; fillRow(all[k], k); await wait(1100); } }
      if(p === 2){ reset(); tk.classList.add('synced'); [...rows, m].forEach((r, k) => { r.classList.add('fill', r === m ? 'gap' : 'ok'); }); links.forEach(l => l.classList.add('on'));
        await wait(2400); if(id !== run) return; tk.classList.add('clicked'); }
    }
    steps.forEach((b, i) => b.addEventListener('click', () => phase(i)));
    function loop(t){
      if(vis.on && !RM){
        const k = (t - start) / DUR[cur];
        steps[cur].style.setProperty('--p', Math.min(1, k));
        if(k >= 1) phase((cur + 1) % 3);
      } else start = t - (parseFloat(steps[cur].style.getPropertyValue('--p')) || 0) * DUR[cur];
      requestAnimationFrame(loop);
    }
    once(tk, () => { tk.classList.add('in'); phase(RM ? 2 : 0); requestAnimationFrame(loop); }, { threshold:0.35 });
  })();

  // ---------- HOME door: questions the orb is hearing ----------
  (function(){
    const q = $('#dq'); if(!q || RM) return;
    const Q = ['What were sales last month?', 'Kaveri Stores ka kitna baaki hai?', 'Who should I chase first?', 'How is my overdraft moving?'];
    let i = 0; const vis = watch(q, 0.2);
    setInterval(() => { if(!vis.on || document.hidden) return; i = (i + 1) % Q.length; q.textContent = Q[i]; q.classList.remove('swap'); void q.offsetWidth; q.classList.add('swap'); }, 2800);
  })();

  // ---------- night shift log: overnight work arrives line by line ----------
  $$('.log[data-play]').forEach(log => {
    const items = $$('li', log), vis = watch(log, 0.3), gap = +(log.dataset.play || 700);
    items.forEach(li => li.classList.add('on'));
    if(RM) return;
    (async function loop(){
      for(;;){
        await wait(3800); await until(vis);
        items.forEach(li => li.classList.remove('on', 'fresh'));
        await wait(400);
        for(const li of items){ li.classList.add('on', 'fresh'); setTimeout(() => li.classList.remove('fresh'), 900); await wait(gap); }
      }
    })();
  });

  // ---------- HOME road + PRODUCT hub: draw in once on arrival ----------
  ['#road', '#hub'].forEach(id => once($(id), () => $(id).classList.add('in'), { threshold:0.3 }));

  // ---------- little scenes that step through a story while on screen (data-steps) ----------
  $$('[data-steps]').forEach(el => {
    const n = +el.dataset.steps, ms = +(el.dataset.ms || 1100), hold = +(el.dataset.hold || 2600), vis = watch(el, 0.3);
    const hook = el.id === 'clock' ? s => { const d = [30, 34, 38, 44][s] || 44; $('.day', el).textContent = 'Day ' + d; el.style.setProperty('--k', (d / 45).toFixed(3)); } : null;
    if(RM){ el.dataset.s = n; hook && hook(n); return; }
    (async function(){ for(;;){ await until(vis); for(let s = 0; s <= n; s++){ el.dataset.s = s; hook && hook(s); await wait(s === n ? hold : ms); } } })();
  });

  // ---------- PRODUCT hub: what Margyn is checking right now ----------
  (function(){
    const c = $('#hubCheck'); if(!c || RM) return;
    const T = ['Invoice and payment · Verified', 'Order and sale · Verified', 'Payment and bill · Verified', 'Settlement and bank · coming'];
    let i = 0; const vis = watch(c, 0.2);
    setInterval(() => { if(!vis.on || document.hidden) return; i = (i + 1) % T.length; c.textContent = T[i]; c.classList.remove('swap'); void c.offsetWidth; c.classList.add('swap'); }, 2400);
  })();

  // ---------- smooth scrolling ----------
  if(window.Lenis && !RM){
    const lenis = new Lenis({ lerp:0.085, wheelMultiplier:0.95, smoothWheel:true });
    (function raf(t){ lenis.raf(t); requestAnimationFrame(raf); })(performance.now());
    $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => { const t = $(a.getAttribute('href')); if(t){ e.preventDefault(); lenis.scrollTo(t, { offset:-70 }); } }));
  }

  // ---------- leaving a page: lift the content away first, where real page transitions can't run ----------
  if(!RM && (location.protocol === 'file:' || !('onpagereveal' in window))){
    $$('a[href$=".html"], a[href*=".html#"]').forEach(a => a.addEventListener('click', e => {
      if(e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
      e.preventDefault(); document.body.classList.add('leaving'); setTimeout(() => { location.href = a.href; }, 320);
    }));
    window.addEventListener('pageshow', () => document.body.classList.remove('leaving'));
  }

  // ---------- AI composer: questions in three modes, each answer shaped to the question ----------
  (function(){
    const box = $('#composer'); if(!box) return;
    const qEl = $('#cq'), ans = $('#cans'), modes = $$('.modes span', box), ind = $('.modes i', box), bar = $('.cbar', box), send = $('.c-send', box);
    const vis = watch(box, 0.25);
    const WHO = '<div class="c-who"><img src="/images/margyn-logo-mark.webp" alt="">Margyn</div>';
    const MON = [['Apr', 52], ['May', 61], ['Jun', 58], ['Jul', 70], ['Aug', 84], ['Sep', 92]];
    const QA = [
      { mode:'chat', q:'What were sales last month?', a:() => WHO + '<div class="c-big">₹2.56 Cr</div><div class="c-sub">September sales, from Tally. Up 6% on August, your best month this year.</div><div class="c-bars">' + MON.map(m => `<span><i data-h="${m[1]}"></i>${m[0]}</span>`).join('') + '</div><div class="c-src"><span class="v">TallyPrime · Sales accounts</span><span>How I got this</span></div>' },
      { mode:'voice', q:'Kaveri Stores ka kitna baaki hai?', a:() => WHO + '<div class="c-big">₹19.8 L</div><div class="c-sub">71 din late hai. Tally mein invoice abhi bhi open hai, aur Razorpay mein koi payment nahi aaya.</div><div class="vs-age" style="opacity:1;transform:none;margin-top:14px"><div class="vs-age-bar"><i style="transform:none"></i></div><span><b>71 days</b> past due · terms 30 days</span></div><div class="c-src"><span class="v">Verified · TallyPrime + Razorpay</span><span>Reminder bhej doon?</span></div>' },
      { mode:'wa', q:'Who should I chase first?', a:() => WHO + '<div class="c-list"><div><em>1</em>Kaveri Stores<span class="n">₹19.8 L</span><small>71 days</small></div><div><em>2</em>Greenleaf Hospitality<span class="n">₹3.18 L</span><small>48 days</small></div><div><em>3</em>Sahyadri Distributors<span class="n">₹2.04 L</span><small>39 days</small></div></div><div class="c-src"><span class="v">Open in Tally, no payment in Razorpay</span><span>Reply 1 to send Kaveri a reminder</span></div>' },
      { mode:'chat', q:'How is my overdraft moving?', a:() => WHO + '<div class="c-sub" style="margin:0">HDFC overdraft, this year. Peak <b>₹48 L</b> on 12 Sept. You use 62% of your limit on an average day.</div><svg class="c-spark" viewBox="0 0 520 110" preserveAspectRatio="none"><defs><linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0B4B8C" stop-opacity=".16"/><stop offset="1" stop-color="#0B4B8C" stop-opacity="0"/></linearGradient></defs><line x1="0" x2="520" y1="14" y2="14"/><text x="4" y="10">Limit ₹60 L</text><path class="a" d="M0,82 C40,74 70,60 110,66 S180,40 220,48 S290,22 330,24 S400,52 440,46 S500,58 520,54 L520,110 L0,110Z"/><path class="l" d="M0,82 C40,74 70,60 110,66 S180,40 220,48 S290,22 330,24 S400,52 440,46 S500,58 520,54"/></svg><div class="c-src"><span class="v">TallyPrime · Bank ledgers</span><span>Interest this year ₹3.1 L</span></div>' },
    ];
    function setMode(mode){
      box.dataset.mode = mode;
      const k = { chat:0, voice:1, wa:2 }[mode];
      modes.forEach((s, j) => s.classList.toggle('on', j === k));
      const s = modes[k]; ind.style.setProperty('--l', s.offsetLeft + 'px'); ind.style.setProperty('--w', s.offsetWidth + 'px');
      bar.classList.toggle('wa', mode === 'wa');
      qEl.dataset.ph = mode === 'voice' ? 'Listening…' : mode === 'wa' ? 'Message Margyn on WhatsApp' : 'Ask Margyn anything';
    }
    function show(html){
      const from = ans.offsetHeight;
      const inner = document.createElement('div'); inner.className = 'c-ans-in swap'; inner.innerHTML = html;
      ans.innerHTML = ''; ans.appendChild(inner);
      const to = inner.offsetHeight;
      ans.style.height = from + 'px'; void ans.offsetHeight; ans.style.height = to + 'px';
      setTimeout(() => { ans.style.height = 'auto'; }, 750);
      $$('.c-bars i', inner).forEach((b, j) => setTimeout(() => { b.style.height = b.dataset.h + '%'; }, RM ? 0 : 250 + j * 80));
    }
    setMode('chat');
    qEl.textContent = QA[0].q; show(QA[0].a());
    if(RM) return;
    (async function loop(){
      let i = 1; await wait(4200);
      for(;;){
        await until(vis);
        const it = QA[i]; setMode(it.mode); qEl.textContent = '';
        await wait(500);
        await typeChars(qEl, it.q, it.mode === 'voice' ? 55 : 38);
        await wait(250); send.classList.add('hit'); setTimeout(() => send.classList.remove('hit'), 300);
        show('<div class="c-who"><img src="/images/margyn-logo-mark.webp" alt="">Margyn <span class="typing"><i></i><i></i><i></i></span></div>');
        await wait(900); show(it.a());
        await wait(4400);
        i = (i + 1) % QA.length;
      }
    })();
    window.addEventListener('resize', () => setMode(box.dataset.mode));
  })();

  // ---------- AI voice: the orb listens, then travels into the answer and becomes Margyn's avatar ----------
  (function(){
    const st = $('#vstage'); if(!st) return;
    const you = $('#vsYou'), txt = $('#vsText'), amt = $('#vsAmt'), state = $('#vsState'), steps = $$('.vs-st', st);
    const vis = watch(st, 0.35);
    const phase = (p, label) => { st.dataset.p = p; if(label) state.textContent = label; };
    function reset(){ you.textContent = ''; txt.textContent = ''; amt.textContent = '₹0.0 L'; steps.forEach(s => s.classList.remove('on')); phase(0, 'Listening'); }
    you.textContent = you.dataset.text; txt.textContent = txt.dataset.text; amt.textContent = '₹19.8 L'; steps.forEach(s => s.classList.add('on')); phase(3, 'Waiting for you');
    if(RM) return;
    once(st, async () => {
      await wait(3500);
      for(;;){
        await until(vis);
        reset(); await wait(700);
        await typeWords(you, 150);
        await wait(500);  phase(1, 'Thinking');
        await wait(1100); phase(2, 'Answering'); countUp(amt);
        await wait(500);  await typeWords(txt, 55);
        await wait(300);  phase(3, 'Working');
        for(const s of steps){ s.classList.add('on'); await wait(650); }
        state.textContent = 'Waiting for you';
        await wait(4200); phase(4); await wait(600);
      }
    }, { threshold:0.35 });
  })();

  // ---------- AI WhatsApp phone: messages arrive in order, with typing ----------
  once($('#phone'), () => {
    const msgs = $$('#phBody .msg'), body = $('#phBody');
    let t = 300;
    msgs.forEach((m, i) => {
      const incoming = m.classList.contains('in-m');
      if(incoming && i && !RM){
        setTimeout(() => {
          const ty = document.createElement('div'); ty.className = 'msg in-m typing-m show vis';
          ty.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; body.appendChild(ty);
          setTimeout(() => ty.remove(), 800);
        }, t); t += 800;
      }
      setTimeout(() => { m.classList.add('show'); requestAnimationFrame(() => m.classList.add('vis')); }, RM ? 0 : t);
      t += incoming ? 900 : 700;
    });
  }, { threshold:0.4 });

  // ---------- AI thread + agent pipeline: a token walks the steps, each lights as it passes ----------
  function walker(root, sel, cls, period, at){
    if(!root) return;
    const items = $$(sel, root), vis = watch(root, 0.35);
    once(root, () => {
      root.classList.add('run');
      if(RM){ items.forEach(it => it.classList.add(cls)); return; }
      const t0 = performance.now();
      (function tick(t){
        if(vis.on){ const k = ((t - t0) % period) / period; items.forEach((it, j) => it.classList.toggle(cls, k >= at[j][0] && k < at[j][1])); }
        requestAnimationFrame(tick);
      })(t0);
    }, { threshold:0.35 });
  }
  walker($('#thread'), '.tcard', 'lit', 7500, [[0, .2], [.4, .6], [.86, 1]]);
  walker($('#pipe'), '.pp', 'lit', 6000, [[.02, .18], [.17, .36], [.35, .55], [.55, .8], [.9, 1]]);

  // ---------- AGENTS: the day walks node by node ----------
  (function(){
    const box = $('#dayline'); if(!box) return;
    const card = $('#dayCard'), nodes = $$('.day-n', box), vis = watch(box, 0.4);
    const row = (a, b) => `<li><span>${a}</span><span>${b}</span></li>`;
    const DAY = [
      { t:'Morning update · 7:30 am', h:'<ul>' + row('Cash', '₹1.84 Cr') + row('Late from customers', '₹88.4 L') + row('Cash in 7 days', '₹1.52 Cr') + '</ul>' },
      { t:'Update · 10:30 am', h:'<p>Kaveri Stores paid <b class="num">₹6.2 L</b>. Late money is down to <b class="num">₹82.2 L</b>.</p>' },
      { t:'12:30 pm', h:'<p class="mute">Nothing moved since 10:30, so Margyn stays quiet.</p>', quiet:1 },
      { t:'Update · 3:00 pm', h:'<p>Kiran Packaging\'s bill of <b class="num">₹36,200</b> is now past due. Pay it, or hold?</p>' },
      { t:'Update · 5:00 pm', h:'<p>An unusual payment out: <b class="num">₹2.4 L</b> to a vendor paid for the first time. Worth a look?</p>' },
      { t:'Evening wrap · 7:00 pm', h:'<ul>' + row('Collected today', '₹6.2 L <span class="vs">usual ₹4.1 L</span>') + row('Paid out today', '₹3.9 L') + row('Waiting on you', '6 items') + '</ul>' },
    ];
    let i = 0;
    function show(k){
      i = k;
      nodes.forEach((n, j) => { n.classList.toggle('done', j < k || (j === k && !DAY[j].quiet)); n.classList.toggle('cur', j === k); n.classList.toggle('quiet', !!DAY[j].quiet); });
      box.style.setProperty('--f', k / (DAY.length - 1));
      card.innerHTML = '<b>' + DAY[k].t + '</b>' + DAY[k].h;
      card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
    }
    show(0);
    if(!RM) setInterval(() => { if(vis.on && !document.hidden) show((i + 1) % DAY.length); }, 2600);
  })();

  // ---------- AGENTS: reconciler rows match one by one ----------
  once($('#reconCard'), () => {
    $$('#reconCard .mrow').forEach((r, i) => setTimeout(() => {
      r.classList.add(i === 2 ? 'bad' : 'ok'); r.querySelector('em').textContent = i === 2 ? '≠' : '✓';
    }, RM ? 0 : 500 + i * 450));
  });

  // ---------- AGENTS: a reminder goes out, is read, gets paid ----------
  once($('#remindCard'), async () => {
    const r = $('#remindCard .remind'), n = $('#remindCard [data-count]');
    for(let k = 1; k <= 4; k++){ await wait(k === 1 ? 400 : 900); r.dataset.s = k; }
    countUp(n);
  }, { threshold:0.4 });

  // ---------- PRODUCT tour: auto-advancing tabs ----------
  (function(){
    const tabs = $$('.tab'), tour = $('#tour'); if(!tour || !tabs.length) return;
    const played = {}; let cur = 0, auto = !RM, start, visible = false;
    const DUR = 9000;
    function playCheck(pane){
      const pill = $('#chkPill'), n = $('#tieN'), run = (pane._run = (pane._run || 0) + 1);
      $$('.hc', pane).forEach(r => { r.classList.remove('fixed'); $('.hc-tag', r).textContent = 'Open'; });
      pill.textContent = '6 to fix';
      if(!RM){ const t0 = performance.now();
        (function tick(t){ if(run !== pane._run) return; const k = Math.min(1, (t - t0) / 1400), e = 1 - Math.pow(1 - k, 3);
          n.textContent = Math.round(14212 * e).toLocaleString('en-IN') + ' of 14,212'; if(k < 1) requestAnimationFrame(tick); })(t0); }
      let left = 6;
      $$('.hc[data-fix]', pane).forEach((r, i) => setTimeout(() => {
        if(run !== pane._run) return;
        r.classList.add('fixed'); $('.hc-tag', r).textContent = 'Fixed';
        left--; pill.classList.remove('flip'); void pill.offsetWidth; pill.classList.add('flip');
        setTimeout(() => { pill.textContent = left + ' to fix'; }, RM ? 0 : 220);
      }, RM ? 0 : 2400 + i * 1500));
    }
    function play(key){
      const pane = $('#p-' + key);
      pane.classList.remove('play'); void pane.offsetWidth; pane.classList.add('play');
      if(key === 'fc'){ const p = $('.panel', pane); p.classList.remove('drawn'); void pane.offsetWidth; setTimeout(() => p.classList.add('drawn'), 60); }
      if(key === 'cfo') $$('.p-bars i', pane).forEach((b, i) => { b.style.height = '0'; setTimeout(() => b.style.height = b.dataset.h + '%', 300 + i * 70); });
      if(key === 'chk') playCheck(pane);
      if(key === 'cmp') $$('.cmp tr:not(.th)', pane).forEach((r, i) => { r.style.animation = 'none'; void r.offsetWidth; r.style.animation = `rise .55s var(--out) ${i * 70}ms both`; });
    }
    function select(i, user){
      cur = i;
      tabs.forEach((t, j) => {
        const on = j === i, key = t.id.slice(2);
        t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; t.style.setProperty('--prog', on && auto ? 0 : 1);
        $('#p-' + key).hidden = !on; const c = $('[data-copy="' + key + '"]'); if(c) c.hidden = !on;
      });
      if(user){ auto = false; tabs.forEach(t => t.style.setProperty('--prog', 1)); }
      play(tabs[i].id.slice(2)); start = performance.now();
    }
    function loop(t){
      if(auto && visible){
        const k = (t - start) / DUR;
        tabs[cur].style.setProperty('--prog', Math.min(1, k));
        if(k >= 1) select((cur + 1) % tabs.length);
      } else if(auto) start = t - (parseFloat(tabs[cur].style.getPropertyValue('--prog')) || 0) * DUR;
      requestAnimationFrame(loop);
    }
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(i, true));
      t.addEventListener('keydown', e => { if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){ const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; tabs[n].focus(); select(n, true); } });
    });
    once(tour, () => { select(0); requestAnimationFrame(loop); });
    if('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold:0.3 }).observe(tour);
  })();

  // ---------- PRODUCT connect: one pick per role, cycling through the options ----------
  (function(){
    const roles = $('#hub') || $('#roles'); if(!roles) return;
    const groups = $$('.role:not(.soon) .opts').map(o => $$('span', o)), vis = watch(roles, 0.2);
    groups.forEach(g => g[0].classList.add('pick'));
    if(RM) return;
    let k = 0;
    setInterval(() => {
      if(!vis.on || document.hidden) return; k++;
      groups.forEach((g, j) => { if(g.length < 2) return; const n = Math.floor((k + j) / 1) % g.length; g.forEach((s, x) => s.classList.toggle('pick', x === n)); });
    }, 2200);
  })();

  // ---------- spotlight hover on cards ----------
  $$('.spot').forEach(el => el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px'); el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }));

  // ---------- FAQ ----------
  $$('.faq-item').forEach(item => {
    const btn = $('.faq-q', item);
    btn.addEventListener('click', () => { const open = !item.classList.contains('open'); item.classList.toggle('open', open); btn.setAttribute('aria-expanded', open); });
  });
})();

// ---------- waitlist (same endpoint + payload as live index.html) ----------
(function(){
  const STORAGE_KEY = 'margyn_waitlist_status';
  const backdrop = document.getElementById('wlBackdrop'); if(!backdrop) return;
  const form = document.getElementById('wlForm');
  const formWrap = document.getElementById('wlFormWrap');
  const successEl = document.getElementById('wlSuccess');
  const submitBtn = document.getElementById('wlSubmit');
  const errorEl = document.getElementById('wlError');
  const joined = () => { try { return localStorage.getItem(STORAGE_KEY) === 'joined'; } catch(e){ return false; } };
  const markJoined = () => { try { localStorage.setItem(STORAGE_KEY, 'joined'); } catch(e){} };
  function open(prefillEmail){
    backdrop.classList.remove('gate-closed'); document.body.style.overflow = 'hidden';
    if(joined()){ formWrap.style.display = 'none'; successEl.classList.add('show'); return; }
    if(prefillEmail) document.getElementById('wlEmail').value = prefillEmail;
    setTimeout(() => document.getElementById('wlName').focus(), 60);
  }
  function close(){ backdrop.classList.add('gate-closed'); document.body.style.overflow = ''; }
  document.querySelectorAll('[data-open-wl]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
  const hc = document.getElementById('heroCapture');
  if(hc) hc.addEventListener('submit', (e) => { e.preventDefault(); open(document.getElementById('heroEmail').value.trim()); });
  document.getElementById('wlClose').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });
  window.addEventListener('keydown', (e) => { if(e.key === 'Escape' && !backdrop.classList.contains('gate-closed')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.remove('show');
    const data = {
      name: document.getElementById('wlName').value.trim(),
      email: document.getElementById('wlEmail').value.trim(),
      business_name: document.getElementById('wlBusiness').value.trim(),
      revenue_range: document.getElementById('wlRevenue').value,
      marketing_opt_in: document.getElementById('wlOptIn').checked
    };
    if(!data.name || !data.email || !data.business_name || !data.revenue_range){
      errorEl.textContent = 'Please fill in every field.'; errorEl.classList.add('show'); return;
    }
    submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/waitlist', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(data) });
      if(!res.ok) throw new Error('request failed');
      formWrap.style.display = 'none'; successEl.classList.add('show'); markJoined();
      setTimeout(close, 2800);
    } catch(err){
      errorEl.textContent = 'Something went wrong. Please try again.'; errorEl.classList.add('show');
      submitBtn.disabled = false; submitBtn.textContent = 'Request access';
    }
  });
})();

/* Margyn AI hero: a live voice wave that runs through the scene and behind the chat card.
   It "speaks" in bursts like a voice, swells when the card is on Voice, and rests off screen. */
(function(){
  const hero = document.querySelector('.pg-ai .page-hero'), card = hero && hero.querySelector('.ph-viz');
  if(!hero || !card) return;
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = document.createElement('canvas'); cv.className = 'ai-wave'; cv.setAttribute('aria-hidden', 'true');
  hero.appendChild(cv);
  const ctx = cv.getContext('2d'); let W = 0, H = 0, dpr = 1;
  const place = () => {
    const hr = hero.getBoundingClientRect(), cr = card.getBoundingClientRect();
    const grid = hero.querySelector('.ph-grid').getBoundingClientRect();
    const mid = grid.top - hr.top + grid.height / 2;   // the middle of the hero, level with the headline and the card
    cv.style.top = Math.round(mid - 110) + 'px';
    dpr = Math.min(2, window.devicePixelRatio || 1); W = hero.clientWidth; H = 220;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const STRANDS = [
    { c:['rgba(242,166,59,0)', 'rgba(224,87,58,.85)', 'rgba(242,166,59,.75)'], amp:1, k:2.6, sp:1.15, ph:0, w:1.8 },
    { c:['rgba(255,143,168,0)', 'rgba(255,143,168,.7)', 'rgba(224,87,58,.55)'], amp:.7, k:3.4, sp:1.6, ph:1.7, w:1.3 },
    { c:['rgba(242,166,59,0)', 'rgba(242,166,59,.6)', 'rgba(255,143,168,.5)'], amp:.45, k:4.3, sp:2.1, ph:3.1, w:1 },
  ];
  const composer = hero.querySelector('.composer');
  let level = 0.5;
  function frame(t){
    t /= 1000;
    const mode = composer && composer.dataset.mode;
    const target = mode === 'voice' ? 1 : mode === 'wa' ? 0.7 : 0.58;
    level += (target - level) * 0.04;
    // syllable-like bursts: two slow sines multiplied, never fully silent
    const talk = 0.35 + 0.65 * Math.abs(Math.sin(t * 2.1) * Math.sin(t * 0.77 + 1.3));
    ctx.clearRect(0, 0, W, H);
    const cy = H / 2, A = (H / 2 - 12) * level * talk;
    for(const s of STRANDS){
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, s.c[0]); g.addColorStop(0.55, s.c[1]); g.addColorStop(1, s.c[2]);
      ctx.strokeStyle = g; ctx.lineWidth = s.w; ctx.beginPath();
      for(let x = 0; x <= W; x += 4){
        const u = x / W;
        const env = Math.sin(Math.PI * Math.min(1, Math.max(0, (u + 0.05) / 1.1))) ** 1.2;   // swells mid-scene, tapers at the ends
        const y = cy + A * s.amp * env * Math.sin(u * s.k * Math.PI * 2 - t * s.sp * 2 + s.ph) * (0.75 + 0.25 * Math.sin(u * 9 + t));
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }
  place(); window.addEventListener('resize', place);
  if(RM){ frame(2400); return; }
  let on = true, raf = 0;
  const loop = t => { frame(t); raf = on ? requestAnimationFrame(loop) : 0; };
  if('IntersectionObserver' in window) new IntersectionObserver(([e]) => { on = e.isIntersecting; if(on && !raf) raf = requestAnimationFrame(loop); }).observe(hero);
  raf = requestAnimationFrame(loop);
  setTimeout(place, 1200);   // the card settles after its entrance animation
})();
