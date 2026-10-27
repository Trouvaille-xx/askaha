'use strict';
/*
 * 把原生 <select class="eval-select"> 换成完全自定义的下拉 (按钮 + 浮层菜单)。
 * 保留原生 select 作为数据源 (.value / .selectedIndex / change 事件照常)，只隐藏它、
 * 在旁边放一个 .cs 控件。选项重建 (innerHTML) 由 MutationObserver 自动同步。
 */
(function () {
  function setup(sel) {
    if (sel.dataset.cs) return;
    sel.dataset.cs = '1';
    sel.classList.add('cs-native');

    const wrap = document.createElement('span');
    wrap.className = 'cs';
    if (sel.style && sel.style.cssText) wrap.style.cssText = sel.style.cssText;
    wrap.innerHTML = '<button type="button" class="cs-btn"><span class="cs-label"></span>'
      + '<svg class="cs-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg></button>'
      + '<div class="cs-menu" hidden></div>';
    sel.parentNode.insertBefore(wrap, sel);

    const label = wrap.querySelector('.cs-label');
    const menu = wrap.querySelector('.cs-menu');
    const btn = wrap.querySelector('.cs-btn');

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
    };
    const build = () => {
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, (o, i) => {
        const it = document.createElement('div');
        it.className = 'cs-opt' + (i === sel.selectedIndex ? ' active' : '');
        it.textContent = o.textContent;
        it.onclick = (e) => {
          e.stopPropagation();
          sel.selectedIndex = i;
          sel.value = o.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sync();
          close();
        };
        menu.appendChild(it);
      });
    };
    const close = () => { menu.hidden = true; wrap.classList.remove('open'); };
    const open = () => {
      document.querySelectorAll('.cs.open').forEach((w) => {
        if (w !== wrap) { const m = w.querySelector('.cs-menu'); if (m) m.hidden = true; w.classList.remove('open'); }
      });
      sync();
      build();
      menu.hidden = false;
      wrap.classList.add('open');
    };

    btn.onclick = (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); };
    document.addEventListener('click', close);
    sel.addEventListener('change', sync);
    new MutationObserver(sync).observe(sel, { childList: true });
    sel._csSync = sync;
    sync();
  }

  function enhance(root) {
    (root || document).querySelectorAll('select.eval-select:not([data-cs])').forEach(setup);
  }
  // 供调用方在"用代码改了 value"之后手动刷新标签 (MutaionObserver 只能看到选项重建)
  window.syncEvalSelects = () => {
    document.querySelectorAll('select.eval-select').forEach((s) => { if (s._csSync) s._csSync(); });
  };
  window.enhanceEvalSelects = enhance;
  if (document.readyState !== 'loading') enhance();
  else document.addEventListener('DOMContentLoaded', () => enhance());
})();
