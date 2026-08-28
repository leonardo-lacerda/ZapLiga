(function(){
"use strict";
var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- nav ---------- */
var nav = document.getElementById('nav');
function onScroll(){ nav.classList.toggle('scrolled', window.scrollY > 10); }
window.addEventListener('scroll', onScroll, {passive:true}); onScroll();

var burger = document.getElementById('burger');
var menu = document.getElementById('mobileMenu');
burger.addEventListener('click', function(){
  var open = menu.classList.toggle('open');
  burger.classList.toggle('open', open);
  burger.setAttribute('aria-expanded', open);
});
menu.querySelectorAll('a').forEach(function(a){
  a.addEventListener('click', function(){
    menu.classList.remove('open'); burger.classList.remove('open');
    burger.setAttribute('aria-expanded','false');
  });
});

/* ---------- reveal ---------- */
var io = new IntersectionObserver(function(entries){
  entries.forEach(function(e){
    if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
  });
},{threshold:.15});
document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });

/* ---------- scramble ---------- */
function scramble(el){
  var finalText = el.getAttribute('data-text') || el.textContent;
  var chars = '01#/<>+*';
  var frame = 0, total = Math.max(16, finalText.length * 3);

  /* lock the box to its final size so swapping glyphs never reflows the page */
  var rect = el.getBoundingClientRect();
  el.style.display = 'inline-block';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.style.overflow = 'hidden';
  el.style.whiteSpace = 'nowrap';
  el.style.verticalAlign = 'top';

  function step(){
    frame++;
    var out = '';
    for(var i = 0; i < finalText.length; i++){
      var revealAt = (i / finalText.length) * total * 0.7;
      out += (frame > revealAt + 6) ? finalText[i] : chars[Math.floor(Math.random() * chars.length)];
    }
    el.textContent = out;
    if(frame < total + 8){ requestAnimationFrame(step); } else {
      el.textContent = finalText;
      el.style.width = '';
      el.style.height = '';
    }
  }
  requestAnimationFrame(step);
}
if(!reduced){
  document.querySelectorAll('.scramble').forEach(function(el, i){
    setTimeout(function(){ scramble(el); }, 350 + i * 250);
  });
}

/* ---------- counters ---------- */
function countUp(el){
  var to = parseFloat(el.getAttribute('data-to'));
  var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
  var pre = el.getAttribute('data-pre') || '';
  var suf = el.getAttribute('data-suf') || '';
  function fmt(v){ return pre + v.toLocaleString('pt-BR',{minimumFractionDigits:dec, maximumFractionDigits:dec}) + suf; }
  if(reduced){ el.textContent = fmt(to); return; }
  var t0 = performance.now(), dur = 1500;
  function tick(t){
    var p = Math.min(1, (t - t0) / dur);
    var e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(to * e);
    if(p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
var cio = new IntersectionObserver(function(entries){
  entries.forEach(function(e){
    if(e.isIntersecting){ countUp(e.target); cio.unobserve(e.target); }
  });
},{threshold:.5});
document.querySelectorAll('.counter').forEach(function(el){ cio.observe(el); });

/* ---------- marquee (duplica trilha) ---------- */
var mq = document.getElementById('mqTrack');
if(mq){ mq.innerHTML += mq.innerHTML; }

/* ---------- dashboard: gráfico com abas ---------- */
var chartEl = document.getElementById('chartBars');
var chartTotal = document.getElementById('chartTotal');
var datasets = {
  hoje: { labels:['9h','10h','11h','12h','13h','14h','15h','16h','17h','18h','19h','20h'],
          values:[38,64,82,57,44,71,96,104,88,76,59,41] },
  semana:{ labels:['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'],
          values:[312,428,396,511,468,244,96] }
};
function renderChart(key){
  var d = datasets[key];
  var max = Math.max.apply(null, d.values);
  var total = d.values.reduce(function(a,b){ return a + b; }, 0);
  chartTotal.textContent = total.toLocaleString('pt-BR') + (key === 'hoje' ? ' hoje' : ' na semana');
  chartEl.innerHTML = d.values.map(function(v, i){
    return '<div class="cb" title="' + d.labels[i] + ': ' + v + ' chamadas via WhatsApp">' +
           '<div class="cb-bar' + (v === max ? ' peak' : '') + '" data-h="' + (v / max * 100).toFixed(1) + '"></div>' +
           '<span class="cb-lab">' + d.labels[i] + '</span></div>';
  }).join('');
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    chartEl.querySelectorAll('.cb-bar').forEach(function(b, i){
      b.style.transitionDelay = (i * 40) + 'ms';
      b.style.height = b.getAttribute('data-h') + '%';
    });
  });});
}
document.querySelectorAll('.tab').forEach(function(tab){
  tab.addEventListener('click', function(){
    document.querySelectorAll('.tab').forEach(function(t){
      t.classList.remove('active'); t.setAttribute('aria-selected','false');
    });
    tab.classList.add('active'); tab.setAttribute('aria-selected','true');
    renderChart(tab.getAttribute('data-key'));
  });
});
renderChart('hoje');

/* ---------- console ao vivo ---------- */
var listEl = document.getElementById('callList');
var stripEl = document.getElementById('sdrStrip');
var filaEl = document.getElementById('statFila');
var simEl = document.getElementById('statSim');
var atEl = document.getElementById('statAtend');
var msgEl = document.getElementById('consoleMsg');
var TICK = 900;
var pad = function(n){ return String(n).padStart(2, '0'); };
var fmtT = function(s){ return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
var genPhone = function(){ return '+55 ' + pad(11 + Math.floor(Math.random() * 81)) + ' 9••••-' + (1000 + Math.floor(Math.random() * 9000)); };
var retryTimes = ['09:40','10:15','11:05','14:32','15:20','16:45','17:10'];
var WA_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.5 15.3L2 22l4.9-1.4A10 10 0 1 0 12 2zm5.5 14.2c-.24.66-1.36 1.26-1.9 1.3-.5.06-1.13.09-1.83-.12a16 16 0 0 1-1.66-.61c-2.93-1.26-4.84-4.2-4.99-4.4-.14-.19-1.2-1.6-1.2-3.05s.76-2.16 1.03-2.46c.27-.3.6-.37.8-.37h.57c.18 0 .43-.07.67.51.24.6.83 2.03.9 2.17.07.15.12.32.02.51-.1.2-.15.32-.3.5-.15.19-.31.42-.45.56-.15.15-.3.31-.14.6.17.3.76 1.25 1.63 2.02 1.12 1 2.07 1.3 2.36 1.45.3.15.46.13.63-.07.17-.2.73-.85.93-1.15.2-.3.39-.24.66-.14.27.1 1.7.8 2 .95.29.15.48.22.55.34.07.13.07.73-.18 1.38z"/></svg>';
var sdridades = ['Ana','Bruno','Carla','Diego','Elisa'].map(function(n){ return {name:n, state:'livre', timer:0}; });
var calls = [], fila = 34, atendidas = 412, tickN = 0, nextId = 1;
var msgs = [
  '<b>chamadas via WhatsApp</b> · cooldown ok · janela aberta',
  'pool: <b>12 números WhatsApp saudáveis</b> · 1 em cooldown',
  'roteamento: <b>Ana</b> é a próxima SDR livre',
  'nova chamada de WhatsApp agendada para <b>14:32</b>',
  'distribuição equilibrada · nenhum SDR ocioso há 40s'
];

function rowHTML(c){
  var t = fmtT(Math.round(c.age * TICK / 1000));
  var phone = '<span class="cr-phone">' + WA_ICON + c.phone + '</span>';
  var time = '<span class="cr-time">' + t + '</span>';
  if(c.state === 'discando') return phone + '<span class="cr-chip c-disc"><i></i>discando</span>' + time;
  if(c.state === 'chamando') return phone + '<span class="cr-chip c-ring"><i></i>chamando no WhatsApp…</span>' + time;
  if(c.state === 'atendido') return phone + '<span class="cr-chip c-ok"><i></i>atendeu · rota p/ ' + c.sdr + '</span><span class="cr-time">⚡</span>';
  if(c.state === 'conversa') return phone + '<span class="cr-chip c-live"><i></i>em conversa · ' + c.sdr + '</span>' + time;
  return phone + '<span class="cr-chip c-warn"><i></i>sem resposta · retry ' + c.retry + '</span><span class="cr-time">·</span>';
}
function renderSdrs(){
  stripEl.innerHTML = sdridades.map(function(s){
    var cls = s.state === 'livre' ? 's-free' : (s.state === 'conectando' ? 's-conn' : 's-busy');
    return '<span class="sdr ' + cls + '"><i></i>' + s.name + '</span>';
  }).join('');
}
function renderStatic(){
  var snap = [
    {phone:'+55 11 9••••-4821', state:'chamando', age:8},
    {phone:'+55 21 9••••-0347', state:'atendido', age:11, sdr:'Carla'},
    {phone:'+55 31 9••••-7759', state:'discando', age:2},
    {phone:'+55 41 9••••-1204', state:'falhou', age:14, retry:'14:32'},
    {phone:'+55 11 9••••-6683', state:'conversa', age:31, sdr:'Bruno'}
  ];
  listEl.innerHTML = snap.map(function(c){
    return '<li class="call-row">' + rowHTML({state:c.state, age:c.age, phone:c.phone, sdr:c.sdr, retry:c.retry}) + '</li>';
  }).join('');
  sdridades[0].state = 'livre'; sdridades[1].state = 'em conversa'; sdridades[2].state = 'conectando'; sdridades[3].state = 'livre'; sdridades[4].state = 'em conversa';
  renderSdrs();
}
function tick(){
  if(document.hidden) return;
  tickN++;
  var active = calls.filter(function(c){ return c.state === 'discando' || c.state === 'chamando'; }).length;
  if(calls.length < 6 && active < 5 && Math.random() < 0.6){
    calls.push({id:nextId++, phone:genPhone(), state:'discando', age:0, next:2 + Math.floor(Math.random() * 2), sdr:null, retry:null, el:null, gone:false});
  }
  calls.forEach(function(c){
    c.age++;
    if(c.state === 'discando' && c.age >= c.next){
      c.state = 'chamando'; c.next = c.age + 5 + Math.floor(Math.random() * 7);
    } else if(c.state === 'chamando' && c.age >= c.next){
      var free = null;
      for(var i = 0; i < sdridades.length; i++){ if(sdridades[i].state === 'livre'){ free = sdridades[i]; break; } }
      if(Math.random() < 0.6 && free){
        c.state = 'atendido'; c.sdr = free.name; free.state = 'conectando';
        atendidas++; c.next = c.age + 2;
      } else {
        c.state = 'falhou'; c.retry = retryTimes[Math.floor(Math.random() * retryTimes.length)]; c.next = c.age + 3;
      }
    } else if(c.state === 'atendido' && c.age >= c.next){
      c.state = 'conversa'; c.next = c.age + 4 + Math.floor(Math.random() * 4);
      var s = sdridades.find(function(x){ return x.name === c.sdr; });
      if(s){ s.state = 'em conversa'; s.timer = c.next - c.age; }
    } else if(c.state === 'conversa'){
      var sd = sdridades.find(function(x){ return x.name === c.sdr; });
      if(sd){ sd.timer--; if(sd.timer <= 0) sd.state = 'livre'; }
      if(c.age >= c.next) c.gone = true;
    } else if(c.state === 'falhou' && c.age >= c.next){
      c.gone = true;
    }
  });
  calls.forEach(function(c){
    if(!c.el){
      c.el = document.createElement('li');
      c.el.className = 'call-row';
      listEl.appendChild(c.el);
    }
    c.el.innerHTML = rowHTML(c);
    if(c.gone) c.el.classList.add('out');
  });
  calls = calls.filter(function(c){
    if(c.gone){ var el = c.el; setTimeout(function(){ if(el && el.parentNode) el.parentNode.removeChild(el); }, 380); return false; }
    return true;
  });
  fila = Math.max(26, Math.min(46, fila + Math.floor(Math.random() * 5) - 2));
  var sim = calls.filter(function(c){ return ['discando','chamando','atendido','conversa'].indexOf(c.state) > -1; }).length;
  filaEl.textContent = fila;
  simEl.textContent = sim;
  atEl.textContent = atendidas;
  renderSdrs();
  if(tickN % 5 === 0){
    msgEl.innerHTML = 'motor ▸ ' + msgs[Math.floor(tickN / 5) % msgs.length];
  }
}
if(reduced){
  renderStatic();
} else {
  tick();
  setInterval(tick, TICK);
}

/* ---------- FAQ ---------- */
document.querySelectorAll('.faq-q').forEach(function(btn){
  btn.addEventListener('click', function(){
    var item = btn.parentElement;
    var panel = item.querySelector('.faq-a');
    var open = item.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
    panel.style.maxHeight = open ? panel.scrollHeight + 'px' : '0px';
  });
});
var firstFaq = document.querySelector('.faq-item');
if(firstFaq){
  firstFaq.classList.add('open');
  firstFaq.querySelector('.faq-q').setAttribute('aria-expanded','true');
  var fp = firstFaq.querySelector('.faq-a');
  requestAnimationFrame(function(){ fp.style.maxHeight = fp.scrollHeight + 'px'; });
}

/* ---------- nav ativa dos recursos ---------- */
var resLinks = Array.prototype.slice.call(document.querySelectorAll('.res-link'));
var secIO = new IntersectionObserver(function(entries){
  entries.forEach(function(e){
    if(e.isIntersecting){
      resLinks.forEach(function(l){ l.classList.toggle('active', l.getAttribute('href') === '#' + e.target.id); });
    }
  });
},{rootMargin:'-30% 0px -60% 0px'});
document.querySelectorAll('.feat-block').forEach(function(b){ secIO.observe(b); });
})();
