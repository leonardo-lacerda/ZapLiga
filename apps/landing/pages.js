(function(){
"use strict";

/* ---------- nav ---------- */
var nav = document.getElementById('nav');
if(nav){
  function onScroll(){ nav.classList.toggle('scrolled', window.scrollY > 10); }
  window.addEventListener('scroll', onScroll, {passive:true}); onScroll();
}

var burger = document.getElementById('burger');
var menu = document.getElementById('mobileMenu');
if(burger && menu){
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
}

/* ---------- reveal ---------- */
var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var revealEls = document.querySelectorAll('.reveal');
if(revealEls.length){
  if(reduced){
    revealEls.forEach(function(el){ el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
      });
    },{threshold:.15});
    revealEls.forEach(function(el){ io.observe(el); });
  }
}

/* ---------- FAQ / accordion ---------- */
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

/* ---------- sumário ativo (guias e páginas legais) ---------- */
var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.res-link'));
var tocSections = document.querySelectorAll('.legal-section[id], .feat-block[id]');
if(tocLinks.length && tocSections.length){
  var secIO = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        tocLinks.forEach(function(l){ l.classList.toggle('active', l.getAttribute('href') === '#' + e.target.id); });
      }
    });
  },{rootMargin:'-30% 0px -60% 0px'});
  tocSections.forEach(function(s){ secIO.observe(s); });
}
})();
