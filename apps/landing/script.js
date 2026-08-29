(function(){
  "use strict";
  var RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Scroll: header + progress + to-top ---------- */
  var header = document.getElementById("siteHeader");
  var prog = document.getElementById("progress");
  var toTop = document.getElementById("toTop");
  function onScroll(){
    var h = document.documentElement;
    header.classList.toggle("scrolled", window.scrollY > 8);
    var max = h.scrollHeight - h.clientHeight;
    prog.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + "%";
    toTop.classList.toggle("show", window.scrollY > 700);
  }
  window.addEventListener("scroll", onScroll, {passive:true});
  onScroll();
  toTop.addEventListener("click", function(){
    window.scrollTo({top:0, behavior: RM ? "auto" : "smooth"});
  });

  /* ---------- Mobile menu ---------- */
  var burger = document.getElementById("burger");
  var panel = document.getElementById("mobilePanel");
  function closeMenu(){
    panel.classList.remove("open");
    burger.setAttribute("aria-expanded","false");
    burger.firstElementChild.innerHTML = "<use href='#i-menu'></use>";
  }
  burger.addEventListener("click", function(){
    var open = panel.classList.toggle("open");
    burger.setAttribute("aria-expanded", String(open));
    burger.firstElementChild.innerHTML = open ? "<use href='#i-x'></use>" : "<use href='#i-menu'></use>";
  });
  panel.querySelectorAll("a").forEach(function(a){ a.addEventListener("click", closeMenu); });

  /* ---------- Formatting ---------- */
  function fmt(n, dec){
    return n.toLocaleString("pt-BR", {minimumFractionDigits: dec, maximumFractionDigits: dec});
  }
  function bump(el){ el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }

  /* ---------- Count-up ---------- */
  function runCount(el){
    var to = parseFloat(el.dataset.to) || 0;
    var dec = parseInt(el.dataset.dec || "0", 10);
    var suf = el.dataset.suf || "";
    if (RM) { el.textContent = fmt(to, dec) + suf; return; }
    var t0 = null, dur = 1200;
    function tick(ts){
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * e, dec) + suf;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ---------- Reveal + counters ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");
  var countEls = document.querySelectorAll(".count");
  if (RM || !("IntersectionObserver" in window)) {
    revealEls.forEach(function(el){ el.classList.add("is-in"); });
    countEls.forEach(runCount);
  } else {
    var counted = new WeakSet();
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.classList.add("is-in");
        if (el.classList.contains("count") && !counted.has(el)) { counted.add(el); runCount(el); }
        el.querySelectorAll(".count").forEach(function(c){
          if (!counted.has(c)) { counted.add(c); runCount(c); }
        });
        io.unobserve(el);
      });
    }, {threshold: 0.15, rootMargin: "0px 0px -40px 0px"});
    revealEls.forEach(function(el){ io.observe(el); });
    countEls.forEach(function(el){ io.observe(el); });
  }

  /* ---------- Active nav ---------- */
  var navLinks = document.querySelectorAll("[data-navlink]");
  var navSections = ["produto","como-funciona","para-quem","precos"]
    .map(function(id){ return document.getElementById(id); }).filter(Boolean);
  if ("IntersectionObserver" in window) {
    var nio = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (!entry.isIntersecting) return;
        navLinks.forEach(function(l){
          l.classList.toggle("active", l.dataset.navlink === entry.target.id);
        });
      });
    }, {rootMargin: "-38% 0px -55% 0px"});
    navSections.forEach(function(s){ nio.observe(s); });
  }

  /* ---------- Hero tilt ---------- */
  var heroVisual = document.getElementById("heroVisual");
  var heroWindow = document.getElementById("heroWindow");
  if (!RM && heroVisual && heroWindow && window.matchMedia("(pointer:fine)").matches) {
    var tiltOn = window.innerWidth > 940;
    heroVisual.addEventListener("mousemove", function(e){
      if (!tiltOn) return;
      var r = heroVisual.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - .5;
      var py = (e.clientY - r.top) / r.height - .5;
      heroWindow.style.transform = "rotateX(" + (-py * 3.2) + "deg) rotateY(" + (px * 4) + "deg)";
    });
    heroVisual.addEventListener("mouseleave", function(){ heroWindow.style.transform = ""; });
    window.addEventListener("resize", function(){ tiltOn = window.innerWidth > 940; }, {passive:true});
  }

  /* ---------- Spotlight (cursor) ---------- */
  if (!RM && window.matchMedia("(pointer:fine)").matches) {
    document.querySelectorAll(".spot").forEach(function(el){
      el.addEventListener("mousemove", function(e){
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", (e.clientX - r.left) + "px");
        el.style.setProperty("--my", (e.clientY - r.top) + "px");
      });
    });
  }

  /* ---------- Magnetic CTAs ---------- */
  if (!RM && window.matchMedia("(pointer:fine)").matches) {
    document.querySelectorAll(".btn--lg").forEach(function(btn){
      btn.addEventListener("mousemove", function(e){
        var r = btn.getBoundingClientRect();
        var mx = (e.clientX - r.left - r.width / 2) / r.width;
        var my = (e.clientY - r.top - r.height / 2) / r.height;
        btn.style.transform = "translate(" + (mx * 8) + "px," + (my * 6) + "px)";
      });
      btn.addEventListener("mouseleave", function(){ btn.style.transform = ""; });
    });
  }

  /* ---------- Hero clock ---------- */
  var clockEl = document.getElementById("heroClock");
  function updClock(){
    var d = new Date();
    var days = ["dom","seg","ter","qua","qui","sex","sáb"];
    var hh = String(d.getHours()).padStart(2,"0");
    var mm = String(d.getMinutes()).padStart(2,"0");
    clockEl.textContent = days[d.getDay()] + " · " + hh + ":" + mm;
  }
  updClock();
  setInterval(updClock, 30000);

  /* ---------- Hero live simulation ---------- */
  var LEAD_STATES = [["Ligando","call"],["Conectado","ok"],["Na fila","queue"],["Nova tentativa","retry"]];
  var NUM_STATES  = [["Disponível","ok"],["Em chamada","call"],["Cooldown","cool"]];
  var leadEls = document.querySelectorAll(".js-lead");
  var numEls = document.querySelectorAll(".js-num");
  var leadIdx = [], numIdx = [];
  leadEls.forEach(function(el){ leadIdx.push(parseInt(el.dataset.off,10)); });
  numEls.forEach(function(el){ numIdx.push(parseInt(el.dataset.off,10)); });
  function setLeadPill(el, state){
    el.className = "pill pill--" + LEAD_STATES[state][1] + " js-lead";
    el.dataset.off = state;
    el.textContent = LEAD_STATES[state][0];
  }
  function setNumPill(el, state){
    el.className = "pill pill--" + NUM_STATES[state][1] + " js-num";
    el.dataset.off = state;
    el.textContent = NUM_STATES[state][0];
  }
  function advancePills(){
    leadEls.forEach(function(el, i){
      leadIdx[i] = (leadIdx[i] + 1) % LEAD_STATES.length;
      setLeadPill(el, leadIdx[i]);
    });
    numEls.forEach(function(el, i){
      numIdx[i] = (numIdx[i] + 1) % NUM_STATES.length;
      setNumPill(el, numIdx[i]);
    });
  }
  var bursting = false;
  var tentativas = 846, atendHero = 137, callsHero = 12;
  var tentEl = document.getElementById("heroTentativas");
  var atendEl = document.getElementById("heroAtend");
  var callsEl = document.getElementById("heroCalls");
  var chipCalls = document.getElementById("chipCalls");

  if (!RM) {
    setInterval(function(){
      if (bursting) return;
      advancePills();
    }, 3200);
    setInterval(function(){
      if (bursting) return;
      tentativas += 1 + Math.floor(Math.random() * 3);
      tentEl.textContent = fmt(tentativas, 0);
      bump(tentEl);
      if (Math.random() < .3) {
        atendHero += 1;
        atendEl.textContent = fmt(atendHero, 0);
        bump(atendEl);
      }
      if (Math.random() < .4) {
        callsHero = Math.max(6, Math.min(20, callsHero + (Math.random() < .5 ? -1 : 1)));
        callsEl.textContent = fmt(callsHero, 0);
        chipCalls.textContent = callsHero + " chamadas em andamento";
      }
    }, 4200);
  }

  /* ---------- Burst: simular discagem ---------- */
  var simBtn = document.getElementById("simBtn");
  if (simBtn && !RM) {
    simBtn.addEventListener("click", function(){
      if (bursting) return;
      bursting = true;
      simBtn.classList.add("on");
      var burstTicks = 0;
      var burstInt = setInterval(function(){
        burstTicks++;
        advancePills();
        tentativas += 2 + Math.floor(Math.random() * 5);
        tentEl.textContent = fmt(tentativas, 0);
        bump(tentEl);
        if (burstTicks % 2 === 0) {
          atendHero += 1;
          atendEl.textContent = fmt(atendHero, 0);
          bump(atendEl);
          showToast();
        }
        callsHero = Math.max(6, Math.min(20, callsHero + (Math.random() < .5 ? -1 : 1)));
        callsEl.textContent = fmt(callsHero, 0);
        chipCalls.textContent = callsHero + " chamadas em andamento";
      }, 500);
      setTimeout(function(){
        clearInterval(burstInt);
        bursting = false;
        simBtn.classList.remove("on");
      }, 6500);
    });
  } else if (simBtn) {
    simBtn.style.display = "none";
  }

  /* ---------- Hero toast ---------- */
  var TOASTS = [
    ["Carlos Silva atendeu","Conectado a Ana Prado · agora"],
    ["Nova tentativa agendada","Marcos Lima · em 30 minutos"],
    ["Fernanda Souza conectada","Bruno Costa assumiu a chamada"],
    ["+3 leads na fila","Importação automática concluída"],
    ["Número liberado","+55 31 ****-7720 disponível novamente"],
    ["Ana Santos atendeu","Chamada direcionada a Júlia Mendes"]
  ];
  var toast = document.getElementById("heroToast");
  var toastT = document.getElementById("toastTitle");
  var toastS = document.getElementById("toastSub");
  var ti = 0;
  function showToast(){
    if (!toast || RM) return;
    var t = TOASTS[ti % TOASTS.length]; ti++;
    toastT.textContent = t[0];
    toastS.textContent = t[1];
    toast.classList.remove("show");
    void toast.offsetWidth;
    toast.classList.add("show");
  }
  if (!RM && toast) {
    setTimeout(showToast, 1800);
    setInterval(function(){ if (!bursting) showToast(); }, 8000);
  }

  /* ---------- Cooldown countdown ---------- */
  var cd = document.getElementById("cooldownTimer");
  var cdSec = 84;
  if (cd && !RM) {
    setInterval(function(){
      cdSec--;
      if (cdSec < 0) cdSec = 120;
      var m = String(Math.floor(cdSec / 60)).padStart(2,"0");
      var s = String(cdSec % 60).padStart(2,"0");
      cd.textContent = m + ":" + s;
    }, 1000);
  }

  /* ---------- Calculadora ---------- */
  var cRange = document.getElementById("calcRange");
  var cAtt = document.getElementById("calcAtt");
  var cMin = document.getElementById("calcMin");
  var cOut = document.getElementById("calcOut");
  var cHours = document.getElementById("calcHours");
  var cTents = document.getElementById("calcTents");
  var cDays = document.getElementById("calcDays");
  var cBar = document.getElementById("calcBar");
  function calcValues(n, att, min){
    var hours = n * att * min * 22 / 60;
    return { hours: Math.round(hours), tents: n * att * 22, days: Math.round(hours / 8) };
  }
  function paintCalc(animate){
    var n = parseInt(cRange.value, 10);
    var att = parseInt(cAtt.value, 10);
    var min = parseFloat(cMin.value);
    var v = calcValues(n, att, min);
    cOut.textContent = n + " SDRs";
    cTents.textContent = fmt(v.tents, 0);
    cDays.textContent = fmt(v.days, 0);
    cBar.style.width = ((n - 2) / 78 * 100) + "%";
    cRange.style.setProperty("--fill", ((n - 2) / 78 * 100) + "%");
    if (!animate || RM) { cHours.textContent = fmt(v.hours, 0); return; }
    var from = parseInt(cHours.textContent.replace(/\D/g,""), 10) || 0;
    var t0 = null, dur = 420;
    function step(ts){
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      cHours.textContent = fmt(Math.round(from + (v.hours - from) * p), 0);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    bump(cHours);
  }
  if (cRange) {
    paintCalc(false);
    cRange.addEventListener("input", function(){ paintCalc(true); });
    cAtt.addEventListener("change", function(){ paintCalc(true); });
    cMin.addEventListener("change", function(){ paintCalc(true); });
  }

  /* ---------- Steps interativos ---------- */
  var stepEls = Array.prototype.slice.call(document.querySelectorAll(".step"));
  var stepsHint = document.getElementById("stepsHint");
  var sIdx = 0, sAuto = !RM;
  function actStep(i){
    sIdx = i;
    stepEls.forEach(function(s, j){
      s.classList.toggle("active", j === i);
      if (j === i) {
        var p = s.querySelector(".step-prog");
        p.style.animation = "none";
        void p.offsetWidth;
        p.style.animation = "";
      }
    });
  }
  stepEls.forEach(function(s, i){
    s.addEventListener("click", function(){
      if (sAuto) { sAuto = false; stepsHint.textContent = "▸ Modo manual · clique para navegar entre os passos"; }
      actStep(i);
    });
  });
  actStep(0);
  if (!RM) {
    setInterval(function(){
      if (!sAuto) return;
      actStep((sIdx + 1) % stepEls.length);
    }, 4000);
  } else {
    stepsHint.textContent = "▸ Clique em um passo para destacar";
  }

  /* ---------- Foco toggle ---------- */
  var focoSeg = document.getElementById("focoSeg");
  var fmAb = document.getElementById("fmAb");
  var fmBb = document.getElementById("fmBb");
  var fmAp = document.getElementById("fmAp");
  var fmBp = document.getElementById("fmBp");
  if (focoSeg) {
    focoSeg.addEventListener("click", function(e){
      var b = e.target.closest("button");
      if (!b) return;
      focoSeg.querySelectorAll("button").forEach(function(x){ x.classList.remove("on"); });
      b.classList.add("on");
      var disc = b.dataset.m === "disc";
      fmAb.style.transform = "scaleX(" + (disc ? .14 : .82) + ")";
      fmBb.style.transform = "scaleX(" + (disc ? .78 : .18) + ")";
      fmAp.textContent = disc ? "14%" : "82%";
      fmBp.textContent = disc ? "78%" : "18%";
    });
  }

  /* ---------- Dashboard tabs ---------- */
  var dashTabs = Array.prototype.slice.call(document.querySelectorAll(".dash-tab"));
  var curPane = "geral";
  function setPane(name){
    curPane = name;
    dashTabs.forEach(function(t){
      var on = t.dataset.pane === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".dash-pane").forEach(function(p){
      p.classList.toggle("active", p.id === "pane-" + name);
    });
  }
  dashTabs.forEach(function(t, idx){
    t.addEventListener("click", function(){ setPane(t.dataset.pane); });
    t.addEventListener("keydown", function(e){
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        var ni = (idx + (e.key === "ArrowRight" ? 1 : -1) + dashTabs.length) % dashTabs.length;
        dashTabs[ni].focus();
        setPane(dashTabs[ni].dataset.pane);
      }
    });
  });

  /* ---------- Dashboard live ---------- */
  var dashWin = document.getElementById("dashWindow");
  var kpiTent = document.getElementById("kpiTent");
  var kpiAtend = document.getElementById("kpiAtend");
  var feedList = document.getElementById("feedList");
  var sdrStatus = document.querySelectorAll(".js-sdrst");
  var FEED_POOL = [
    ["Carlos Silva atendeu — conectado a Ana Prado","ok","Conectado"],
    ["Tentativa sem resposta — Fernanda Souza","queue","Na fila"],
    ["Nova tentativa agendada — Marcos Lima · 15 min","retry","Agendada"],
    ["Número +55 11 ****-4291 liberado do cooldown","ok","Disponível"],
    ["Chamada concluída — SDR Bruno Costa · 4:12","call","Concluída"],
    ["+2 leads adicionados à fila Outbound-SP","queue","Fila"],
    ["Júlia Mendes disponível para conexão","ok","Disponível"],
    ["Ricardo Sá entrou em chamada","call","Em chamada"],
    ["Número +55 21 ****-8821 iniciou cooldown","cool","Cooldown"],
    ["Chamada conectada — SDR Larissa Teixeira","ok","Conectado"]
  ];
  var feedI = 0, tickCount = 0;
  function nowHM(){
    var d = new Date();
    return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
  }
  function addFeed(){
    var item = FEED_POOL[feedI % FEED_POOL.length]; feedI++;
    var li = document.createElement("li");
    li.className = "feed-item";
    li.innerHTML = '<span class="feed-time">' + nowHM() + '</span><span class="feed-txt">' + item[0] + '</span><span class="pill pill--' + item[1] + '">' + item[2] + '</span>';
    feedList.insertBefore(li, feedList.firstChild);
    while (feedList.children.length > 6) feedList.removeChild(feedList.lastChild);
  }
  function startDashLive(){
    if (RM) return;
    var tentV = 1284, atendV = 312;
    setInterval(function(){
      tentV += 1 + Math.floor(Math.random() * 3);
      kpiTent.textContent = fmt(tentV, 0);
      bump(kpiTent);
      tickCount++;
      if (tickCount % 3 === 0) {
        atendV += 1;
        kpiAtend.textContent = fmt(atendV, 0);
        bump(kpiAtend);
      }
      if (curPane === "geral") addFeed();
    }, 3800);
    setInterval(function(){
      sdrStatus.forEach(function(el){
        var busy = el.classList.contains("pill--call");
        el.className = "pill " + (busy ? "pill--ok" : "pill--call") + " js-sdrst";
        el.textContent = busy ? "Disponível" : "Em chamada";
      });
    }, 7400);
  }
  if (dashWin && "IntersectionObserver" in window) {
    var dio = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) {
          dio.disconnect();
          setTimeout(startDashLive, 1600);
        }
      });
    }, {threshold: .2});
    dio.observe(dashWin);
  }

  /* ---------- Linhas expansíveis (números) ---------- */
  document.querySelectorAll(".x-row").forEach(function(row){
    function toggle(){
      var detail = row.nextElementSibling;
      var open = detail.classList.toggle("open");
      row.classList.toggle("open", open);
      row.setAttribute("aria-expanded", String(open));
    }
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", function(e){
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });

  /* ---------- FAQ ---------- */
  document.querySelectorAll(".faq-item").forEach(function(item){
    var q = item.querySelector(".faq-q");
    var a = item.querySelector(".faq-a");
    q.addEventListener("click", function(){
      var open = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach(function(o){
        o.classList.remove("open");
        o.querySelector(".faq-a").style.maxHeight = "0px";
        o.querySelector(".faq-q").setAttribute("aria-expanded","false");
      });
      if (!open) {
        item.classList.add("open");
        a.style.maxHeight = a.scrollHeight + "px";
        q.setAttribute("aria-expanded","true");
      }
    });
  });

  /* ---------- Form + validação ---------- */
  var form = document.getElementById("demoForm");
  var formCard = document.getElementById("formCard");
  function validateField(input, showMsg){
    var field = input.closest(".f-field");
    var err = field.querySelector(".f-err");
    var val = input.value.trim();
    var ok = true;
    if (input.id === "f-nome") ok = val.length >= 2;
    if (input.id === "f-email") ok = val.length >= 5 && val.indexOf("@") > 0 && val.indexOf(".") > val.indexOf("@");
    field.classList.toggle("valid", ok && val.length > 0);
    field.classList.toggle("invalid", !ok && (showMsg || val.length > 0));
    if (err) err.textContent = (!ok && (showMsg || val.length > 0)) ? (input.id === "f-nome" ? "Informe seu nome." : "Informe um e-mail válido.") : "";
    return ok;
  }
  form.querySelectorAll(".fv input").forEach(function(inp){
    inp.addEventListener("blur", function(){ validateField(inp, false); });
    inp.addEventListener("input", function(){
      if (inp.closest(".f-field").classList.contains("invalid")) validateField(inp, false);
      else validateField(inp, false);
    });
  });
  form.addEventListener("submit", function(e){
    e.preventDefault();
    var okNome = validateField(document.getElementById("f-nome"), true);
    var okEmail = validateField(document.getElementById("f-email"), true);
    if (!okNome) { document.getElementById("f-nome").focus(); return; }
    if (!okEmail) { document.getElementById("f-email").focus(); return; }
    formCard.classList.add("sent");
  });
})();