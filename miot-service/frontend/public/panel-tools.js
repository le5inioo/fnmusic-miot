/* panel-tools.js
 * 面板轻量改造（不重建 Vue bundle，只注入 CSS + 少量 DOM）：
 *  - 显示比例固定 100%（不再沿用旧的 115% 缩放偏好）；
 *  - 顶栏原「Miotunes / 智能音箱 · 待机」两行文字全部隐去，改为
 *    「连接图标（定制 PNG）+ 三个状态圆点」：音箱连接(红/蓝/绿) / 控制层(红/绿) / 曲库(红/绿)；
 *    图标无提示词，圆点保留原生 title 提示；全部去掉 help 问号光标；
 *  - 「主题切换」并入面板原有应用栏，视觉上排在「选择设备」图标之前；
 *  - 继续播放 + 歌单选择器 + 搜索栏三控件同排；桌面搜索栏 240px、去掉占位文字；
 *  - 手机端：继续播放 / 搜索改为圆形按钮，空间让给歌单框；点搜索圆形可展开输入框；
 *  - 收缩播放器：已播时长在进度条前端、总时长在末端，其余图标垂直居中；
 *    手机端整条上移 20px，播放条下方留白与播放条同色；
 *  - 手机端全屏播放器：主播放键正圆且缩到约 70%，底部控件上移 20px，删掉左右滑动提示；
 *  - 手机端歌单框高于两个圆形按钮；展开搜索框铺满整行；viewport / 输入字号锁死页面缩放；
 *  - 搜索框接入飞牛音乐搜索（与语音点播同源 /compat/library-search?full=1），
 *    结果面板点击即播，播放链路复用 /api/v1/songs/:id/play + /mina/play-url；
 *  - AI 对话播报「未确认」终态残留提示自动隐藏并清理后端状态。
 */
(function () {
  'use strict';
  if (document.getElementById('pt-style')) return;

  var PREFIX = location.pathname
    .replace(/\/(?:index\.html|console)\/?$/, '')
    .replace(/\/$/, '');
  var ZOOM_KEY = 'fnmusic.miot.console.zoom';
  var THEME_KEY = 'fnmusic.miot.theme';
  var apiUrl = function (path) { return PREFIX + path; };

  /* 歌单/歌曲列表 GET 瞬时失败静默重试一次：后端随安装或开机重启的窗口里，
   * 到飞牛音乐网关的链路可能未就绪，「fetch failed」会原样透传成面板上的
   * 「歌曲加载失败」。这里对幂等的列表请求兜底自愈，4xx 不重试。 */
  (function () {
    var orig = window.fetch;
    if (typeof orig !== 'function') return;
    var LIST_RE = /\/playlists(\?|#|$)|\/playlists\/[^/?#]+\/songs(\?|#|$)/;
    window.fetch = function (input, init) {
      var url = '';
      if (typeof input === 'string') url = input;
      else if (input && input.url) url = String(input.url);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method !== 'GET' || !LIST_RE.test(url)) return orig.apply(this, arguments);
      var send = function () { return orig.call(this, input, init); };
      return send().then(function (res) {
        if (res && (res.ok || res.status < 500)) return res;
        return new Promise(function (r) { setTimeout(r, 800); }).then(send);
      }, function () {
        return new Promise(function (r) { setTimeout(r, 800); }).then(send);
      });
    };
  })();

  /* 定制连接图标（160x160 透明 PNG，内嵌避免额外静态文件） */
  var CONN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyZpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTM4IDc5LjE1OTgyNCwgMjAxNi8wOS8xNC0wMTowOTowMSAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTcgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOkVFNTBBQjQyREQwMDExRjE5OEUxODczQUVEQkYxQ0JCIiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOkVFNTBBQjQzREQwMDExRjE5OEUxODczQUVEQkYxQ0JCIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6RUU1MEFCNDBERDAwMTFGMTk4RTE4NzNBRURCRjFDQkIiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6RUU1MEFCNDFERDAwMTFGMTk4RTE4NzNBRURCRjFDQkIiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz5wJoLPAAAJMklEQVR42uydXYxdVRmG15z56Q8tolW80MhUjFNKFZCohQo4NcIFA0qxdLjQmmj8uTARbFoSLGpbhTZCrMYLrTdtuJi2UDDOjUagpLVYjIABSscoFGOiVlDTwlTm1/fL/sbMlPnZ55y9pmftPm/yZk/Sc761z9tnr7X23muf0zQ6OhpQPnV39b1fm0/L18pL5UX+T6/KR+RfyQ/39Hb8kbTyqQkAc4F3jTab5atyvuWAvFEgPk56AFgPeHO1+YH8JcuqyrdbsD+Vvy4Q/0uaAFgtfG/Tple+os5ST8hdgvBfpAqAeeGbr82j8kcLKnlYXikI+0l3oipEMKm2Fwhf8FrbiZUeMO8Jx2M1zPnyzAk7OTGhB5xJWyLAF7zmFuKlB5yu97tEm2ciN3OpesE/kDY94GRaVZI2ADBRXTULbVxNzAA4lZbMQhsdxAyAU2lRSdoAQIQAsHq9WpI2ADBRHZ2FNvqIGQCn0oGStAGAiWrfLLTxIDED4KTyOxQHIzZxkLsgADiTvhmyhQNFy2puJF4AnKkXtNUqOyKU3qHa+0kYAPPotpAtIi1Kh70mAsBcvaCtXL6+IAitxvWshgbAaiG0C8ad8k9qnBOO+ntXei00iVgPmEO+Svp78pU533JIvpM5HwAWDaKtlvmUfJ18UZj4YPoL8i/lnwu8o6QFgIg5IEIAiAAQIQBEAIgQACIARAgAEQAiAEToDKqFCPKpu6uvyfNqk1v977Fv0RqRh+VBeUAe6unt4B5nDnEvOD949q2pH5JXh+wLJ9vltxhs8ivy3+Un5b3yU3I/IAJgvfBVHLzLQvasyCfDzN8daIH+OmTfqv+0gSgIR0gTAKuFr1mbhfLt8h0+7FYjG47vke+TTwrCYVIFwGp6vnMdoC/XWc5+qmGDfIKekLPgvHM+G3a/UQB8JvuNkXVW02sjAJxWNtR+2IfdorTBa7YSLwDm6f02hWIvUbV4TXpBAJwRFLvUsiJC7RV+Ns21VwCcUnaR+TMh3s80rPY2EABOOf9bHrH+cuaBADjTELw4Yv12hmAAnCmPhRHrn0vmADiTmhOtDYAI1TLnmVR+varZz9ra/O8xYO2Wkq0CGVt+NMyqj7NLRfHRMkXhseVHF/tlCftSnvfK53nh4/LfQvZr4A/Iz+t9LD86e8ArjI8JixH8JvxceZl8p3xDyLf86Bch+/ao5+RTqd501+c/X5t/RG7mncrneKL5FM5HZVxx60IXyF+Q7Wtqbwz5Lsg2+Wv3y1+zs0ivhcrV80XhozKO7HNC9iXa253yamXvuVu+y3bUa6JywBeNj4qP6fPkL4ZsCVK9t6Fu86NkHjfeSzPni8ZHxSeUl/sYXQQwTV7r8sBV/7JcKYnGx1jXas8vzClwp+d4zXPoBZPv/aLyYQBeEuL8UrjVvDRw9T9lNcfmwwC8JcRdfjSH/8dkNSc2HwbgFRE/AMuP0lZrbD4MwPaIDSzmRCT5E5CofLD8CE2n6HxUIvdQnICUoxeMxge9EzrjXSxCAIgAECEARACIEAAiAEQIAFG5lcR92u6uvgu0uVXulJfK7wjZI39/lV8O2fMGe3p6O148W/7jlIk9hbZGvka2fN4dsscj/yk/75nsbvRMWho85PaQfU3u6kl6a1sqtMR9nfxdvd4eAdyg0I+VGDzLZGvIHoecbAR7l/taeUujZ1Jp4KBXafOsH+WVnJ/F1q7ZM6ifKyl89rme889ZikwqDRq0PbhiR+6CGt5uD0zvVI11JYPPPs/OkC2RL00mlQYM+mZt7g31r8Ld5rXKAJ8Nt9sKKLXNawHgNBPrXaG4p692ec3UTzZ2FpiJ9YTvAcApjlAfLorS/IJ6jjOprREy2QSAbz7S36fNTRFK36TaFyba+9l+r4pQ+rOeNwCO05pI+2M1b011BI6YSTcATlRnxNofTxTAmJmsBMCJWppo7VQzWQKAE/X2RGvH1KKyZ9JIALYmWjum2sqeCathEAAiAEQIABEAIgSACAARAkAEgAgBIAJAhAAQASBCAIgAECEARACIEAAiAEQIABEAIgSACAARAkAEgAgBIAJAhAAQASBCAIgAECEARACIABAhAEQAiBAAIgBECAARACIEgAgAEQJABIAIASACQIQAEAEgQgCIABAhAEQAWLcGE61NJiUB8JVEa5NJSQA8GrH2kUQBPJJo3kkC+GjE2vsTBfCxRPNOEsAeeTRC3VGvnaJ2yyMR6o40SiYNA2BPb8eftNkXofQ+r52cfL8filD6/kbJpNEuw2yQ+wus1+81U9b6CJlsbJQPZwAORaw/XOUR/2dt1hY0FFuNtV4z2j7Hrq39fzFCJn+p4j1R+TAAT0Zs4ES1cxiF84A26woIfL3XqnZuFDOPk7XM6fxzrC+iN60yk9h5nDAAj0Vs4FgtR5BCuk+b1fJrNQ4xdpR/v4b32r6+FDGPl2rtUfzzrK1xOK41k6HYfBiAT0RswGoP1hj4g9p8UN6Ts9cY8dcu03t31bi/tq+/jZjH4VDHHQj/XMuqzGRvHZkMxuajxXfwq3JThMsfVvuNOgK3HmNNd1dfu7bdcqd8sXy+v+R4yC7W2vWy3T5fqkcDsoH/lYh5DNR5ZjyWyYXa3iKvlC86LZMXQnadb08Nc+DxeiM2HwbgM/IB+eqCGzjgteue1CtEGwbucceUDTm/lw/JKwqu/Rv5qaIm9Q7W3e6YJ01R+bAh+HU/LR8osPiA13xdQY2GROT7avOluwo++xvymv0J5hGVj8q4o35zgQ1s9ppDIT3ZvOdJeWuBNa3W70Kaq3Ki8lFxyk/JP5J/WMDljx97rVMpHe2T9IJ2xrijgJI/81r9CecRjY+m0dGsnia1zdoskD/vc625NUxYN3kDr6n4cEhYnsdC+Xb5Drm1hp7Uer575ZMlyaNwPv4PoDdiQ/I8+TL5W/Incpz9WIFH5O/ITzvZI6EE8jzmyx+Rvy1/LGceBz2Pw97zlSmPQvmYAKA3YgVbPPgPyDfLV8qL5bf6y/4dsouqh/yyxbM+bA2lOMzMEHqT937zPXi7QL5cvkA+z1/2H/nlkF1D3OtBWx6DJc2jMD7eBOBpDVm32+a2v8cWL4z4KfqAe7hsQU8TfJsD2XJaHkM+7A6U8UCMxceUACI0G/qfAAMA57AP1nq5sy8AAAAASUVORK5CYII=';

  /* 状态灯行前的音箱图标：与设置页「设备」项 SlIcon name="speaker" 同款字形，
     轮廓从 miot-ui-icons.otf 的码点 0xe32d 精确提取（24x24）。
     用 currentColor 填充，颜色随主题跟随 --md-on-surface，与菜单下方四个图标一致。
     菜单按钮（三点那个）仍用 CONN_PNG，不受影响。 */
  var SPEAKER_PATHS = 'M17 22H7Q6.18 22 5.59 21.41Q5 20.82 5 20V4'
    + 'Q5 3.17 5.59 2.59Q6.18 2 7 2H17Q17.82 2 18.41 2.59'
    + 'Q19 3.17 19 4V20Q19 20.82 18.41 21.41Q17.82 22 17 22Z'
    + 'M17 20V4H7V20Z'
    + 'M12 9Q12.83 9 13.41 8.41Q14 7.82 14 7Q14 6.18 13.41 5.59'
    + 'Q12.83 5 12 5Q11.18 5 10.59 5.59Q10 6.18 10 7'
    + 'Q10 7.82 10.59 8.41Q11.18 9 12 9Z'
    + 'M12 19Q13.65 19 14.82 17.82Q16 16.65 16 15Q16 13.35 14.82 12.18'
    + 'Q13.65 11 12 11Q10.35 11 9.18 12.18Q8 13.35 8 15'
    + 'Q8 16.65 9.18 17.82Q10.35 19 12 19Z'
    + 'M12 17Q11.18 17 10.59 16.41Q10 15.82 10 15Q10 14.17 10.59 13.59'
    + 'Q11.18 13 12 13Q12.83 13 13.41 13.59Q14 14.17 14 15'
    + 'Q14 15.82 13.41 16.41Q12.83 17 12 17Z';

  /* ------------------------------------------------------------------ 样式 */
  var CSS = [
    ':root { --pt-red:#d92d20; --pt-blue:#2563eb; --pt-green:#12805c;',
    '  --pt-idle:#8a8f98; --pt-bar-bg:#f8f8fc; }',
    ':root[data-theme="dark"] { --pt-red:#ff9d95; --pt-blue:#8ab4f8;',
    '  --pt-green:#7ee2b8; --pt-idle:#9aa0a6; --pt-bar-bg:var(--md-surface); }',

    /* 底部横条 = 展开页 ambient 在「屏幕最底部同高」的一段切片。
       关键：渐变层的 background-size 固定为整个视口高、position 贴底，
       这样 66px 的横条显示的就是全屏渐变最底部那一段，而不是把整幅渐变
       压缩到横条里（位置不同 → 颜色不同）。再叠一层 tint 对应展开页的
       .fullscreen-ambient-tint（底部是 surface 冲淡）；tint 用固定 rgba
       而非 color-mix，兼容手机内置 WebView 老内核。 */
    ':root { --pt-bar-tint:rgba(250,249,254,.44); }',
    ':root[data-theme="dark"] { --pt-bar-tint:rgba(17,17,22,.44); }',
    '.player-bar-shell {',
    '  --md-on-surface:var(--player-palette-on-image);',
    '  --md-on-surface-variant:var(--player-palette-on-image-muted);',
    '  --md-outline:var(--player-palette-on-image-muted);',
    '  --md-outline-variant:var(--player-palette-on-image-faint);',
    '  color:var(--player-palette-on-image);',
    '  background-image:',
    '    linear-gradient(var(--pt-bar-tint), var(--pt-bar-tint)),',
    '    radial-gradient(circle at 14% 10%, var(--player-palette-vibrant, rgb(230,227,247)) 0%, transparent 52%),',
    '    radial-gradient(circle at 88% 24%, var(--player-palette-dominant, rgb(230,227,247)) 0%, transparent 58%),',
    '    linear-gradient(155deg, var(--player-palette-dominant, rgb(230,227,247)),',
    '      var(--player-palette-dark, rgb(230,227,247))) !important;',
    '  background-size:100% 100%, 100vw 100vh, 100vw 100vh, 100vw 100vh !important;',
    '  background-position:center bottom !important;',
    '  background-repeat:no-repeat !important;',
    '  transition:background .8s ease; }',
    'html[data-navigation-style="capsule"] .player-bar-shell::before {',
    '  background-image:',
    '    linear-gradient(var(--pt-bar-tint), var(--pt-bar-tint)),',
    '    radial-gradient(circle at 14% 10%, var(--player-palette-vibrant, rgb(230,227,247)) 0%, transparent 52%),',
    '    radial-gradient(circle at 88% 24%, var(--player-palette-dominant, rgb(230,227,247)) 0%, transparent 58%),',
    '    linear-gradient(155deg, var(--player-palette-dominant, rgb(230,227,247)),',
    '      var(--player-palette-dark, rgb(230,227,247))) !important;',
    '  background-size:100% 100%, 100vw 100vh, 100vw 100vh, 100vw 100vh !important;',
    '  background-position:center bottom !important;',
    '  background-repeat:no-repeat !important; }',

    /* 播放进度条：填充 60%；紫色小圆点与灰色轨道 50% 透明度 */
    '.player-bar-progress-fill, .player-seek-active, .player-mini-progress-active {',
    '  opacity:.6 !important; }',
    '.player-bar-progress-thumb, .player-seek-thumb {',
    '  opacity:.5 !important; }',
    '.player-bar-progress-track, .player-seek-track, .player-mini-progress {',
    '  background-color:rgba(228,225,237,.5) !important; }',
    ':root[data-theme="dark"] .player-bar-progress-track,',
    ':root[data-theme="dark"] .player-seek-track,',
    ':root[data-theme="dark"] .player-mini-progress {',
    '  background-color:rgba(51,49,60,.5) !important; }',

    /* 标题文字全部隐去，只留连接图标 + 三个圆点 */
    '.miot-main-appbar .miot-appbar-title { font-size:0 !important; }',
    '.miot-main-appbar .miot-appbar-subtitle { display:none !important; }',
    '.pt-status { display:inline-flex; align-items:center; gap:9px;',
    '  vertical-align:middle; font-size:0; line-height:1; }',
    '.pt-conn { display:inline-flex; align-items:center; justify-content:center;',
    '  width:20px; height:20px; flex:none; cursor:default;',
    '  color:var(--md-on-surface); }',
    '.pt-conn img { width:20px; height:20px; display:block; object-fit:contain;',
    '  pointer-events:none; }',
    '.pt-conn svg { width:20px; height:20px; display:block; pointer-events:none;',
    '  fill:currentColor; }',
    /* 定制图标的图形重心偏下（两根短竖条中心约在 70% 高度），圆点随之下移 */
    '.pt-dot-sm { position:relative; top:4px;',
    '  width:7px; height:7px; border-radius:50%; flex:none;',
    '  background:currentColor; color:var(--pt-idle); cursor:default;',
    '  box-shadow:0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); }',
    '.pt-dot-sm.red { color:var(--pt-red); }',
    '.pt-dot-sm.blue { color:var(--pt-blue); }',
    '.pt-dot-sm.green { color:var(--pt-green); }',

    /* 主题按钮沿用面板原生 sl-button-icon 外观，order 排到「选择设备」前 */
    '.miot-main-appbar .appbar-actions { width:auto !important; }',
    '.pt-theme-inline { order:-1; }',
    '.pt-theme-inline .sl-button-content { display:inline-flex;',
    '  align-items:center; justify-content:center; }',
    '.pt-theme-inline svg { width:20px; height:20px; display:block; }',

    /* 主题切换的轻提示（不是工具条控件） */
    '.pt-toast { position:fixed; left:50%; bottom:20px; transform:translate(-50%,12px);',
    '  z-index:300; max-width:min(92vw,620px); padding:11px 15px;',
    '  border-radius:14px; border:1px solid var(--md-outline-variant);',
    '  background:var(--md-surface-container-low, var(--md-surface));',
    '  color:var(--md-on-surface); box-shadow:0 8px 22px #0003;',
    '  font-size:13px; line-height:1.55; opacity:0; pointer-events:none;',
    '  transition:opacity .2s ease, transform .2s ease; }',
    '.pt-toast.show { opacity:1; transform:translate(-50%,0); pointer-events:auto; }',
    '@media (prefers-reduced-motion:reduce) { .pt-toast { transition:none; } }',

    /* AI 对话播报「未确认」是终态残留，不再常驻顶部 */
    '.chat-activity.pt-stale { display:none !important; }',

    /* 桌面：40px 圆形「继续播放」+ 240px 搜索框（原 120px 加倍），剩余宽度全给歌单框 */
    '@media (min-width:720px) {',
    '  .miot-page > .player-toolbar { flex-wrap:nowrap; row-gap:0;',
    '    min-height:40px !important; position:relative !important;',
    /* 工具栏提升层叠级别：菜单 #pt-more-menu（z-index:220）被 isolation 困在
       工具栏内部，工具栏自身若 z-index:auto，DOM 靠后的歌曲列表行会盖住菜单，
       导致菜单点不到。给工具栏明确 z-index，让整个工具栏连同菜单盖在列表之上。 */
    '    isolation:isolate !important; background:transparent !important;',
    '    z-index:150 !important; }',
    /* 背景单独铺满视口：按钮留在工具行原位不动，只有 ::before 横向撑到窗口两侧，
       上贴窗口顶（抵消 .miot-page 的 10px+safe-top），下贴下一行上沿（16px margin）。 */
    '  .miot-page > .player-toolbar::before { content:""; position:absolute;',
    '    z-index:-1; pointer-events:none;',
    '    top:calc(-10px - var(--sl-safe-top, 0px)) !important; bottom:-16px !important;',
    '    left:50% !important; transform:translateX(-50%) !important; width:100vw !important;',
    '    background:var(--md-secondary-container); }',
    '  .miot-page > .player-toolbar > .toolbar-field {',
    '    flex:1 1 0 !important; min-width:170px; }',
    '  .miot-page > .player-toolbar > .toolbar-field .sl-select-trigger {',
    '    height:40px !important; min-height:40px !important; max-height:40px !important; }',
    '  .miot-page > .player-toolbar > .sl-button {',
    '    flex:0 0 40px !important; width:40px !important;',
    '    min-width:40px !important; max-width:40px !important;',
    '    height:40px !important; min-height:40px !important;',
    '    padding:0 !important; margin:0 !important;',
    '    border-radius:50% !important; overflow:hidden; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-button-label { display:none !important; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-icon { font-size:20px !important; }',
    '  .miot-page > .player-toolbar > .search-bar {',
    '    flex:0 0 240px !important; width:240px !important;',
    '    min-width:0 !important; max-width:240px !important;',
    '    margin-bottom:0 !important; height:40px;',
    '    padding:0 8px !important; gap:4px !important; }',
    '  .miot-page > .player-toolbar > .search-bar .sl-button-icon {',
    '    width:27px !important; height:27px !important; min-height:27px !important; }',
    /* 让输入文字真正可见：原来是 120px 宽，被图标和两个按钮挤到几乎 0 宽 */
    '  .miot-page > .player-toolbar > .search-bar input {',
    '    flex:1 1 auto !important; min-width:0 !important;',
    '    color:var(--md-on-surface) !important; font-size:14px !important;',
    '    text-overflow:clip !important; }',
    '}',
    /* 占位文字去掉（Vue 重渲染会把 placeholder 加回来，CSS 与 JS 双保险） */
    '.miot-page .search-bar input::placeholder { color:transparent !important; }',

    /* 收缩播放器：已播时长在进度条前端、总时长在末端；其余图标垂直居中 */
    '@media (min-width:600px) {',
    '  .player-bar-standard-desk > .player-bar-progress {',
    '    padding-left:56px; padding-right:56px; box-sizing:border-box; }',
    '  .player-bar-standard-desk .player-bar-time {',
    '    position:absolute !important; top:0; left:16px; right:16px;',
    '    height:16px; line-height:16px; display:flex !important;',
    '    align-items:center; justify-content:space-between; gap:0;',
    '    z-index:2; pointer-events:none; background:transparent !important;',
    '    white-space:nowrap; font-size:12px; }',
    '  .player-bar-standard-desk .player-bar-time .player-bar-time-sep {',
    '    display:none !important; }',
    '  .player-bar-standard-desk .player-bar-center {',
    '    flex-direction:row !important; align-items:center !important;',
    '    justify-content:center !important; }',
    '  .player-bar-standard-desk .player-bar-left,',
    '  .player-bar-standard-desk .player-bar-tools,',
    '  .player-bar-standard-desk .player-bar-center-controls { align-items:center !important; }',
    '}',

    /* 手机端主播放键：底板正圆（桌面档本来就是 50%，不受影响） */
    '.fullscreen-controls-mobile .control-primary.sl-button {',
    '  border-radius:50% !important; }',

    /* ===== 手机/窄屏：工具行三控件一行，两个圆形按钮 ===== */
    '@media (max-width:719px) {',
    '  .miot-page > .player-toolbar { display:flex !important; align-items:center;',
    '    position:relative; isolation:isolate !important; gap:8px !important;',
    '    min-height:0 !important; margin-bottom:8px !important; padding:0 !important;',
    '    border:0 !important; background:transparent !important; }',
    /* 手机端菜单/歌单下拉展开时临时提升工具栏层叠级别：菜单 220、歌单下拉 300
       都被 isolation 困在工具栏内部，平时工具栏 z-index:auto 会被列表行盖住。
       · pt-menu-open  由菜单开关 JS 维护
       · pt-select-open 由 mount 检测 .toolbar-field 下拉面板维护 */
    '  .miot-page > .player-toolbar.pt-menu-open,',
    '  .miot-page > .player-toolbar.pt-select-open { z-index:150 !important; }',
    /* 搜索二级页不能用「提升整个工具栏」：那会让工具栏容器盖在挂 body 的取消按钮
       (z-index:141) 之上，导致取消点不到。改为取消工具栏的 isolation，让搜索框
       自身的 z-index:141 直接在 body 层生效、浮过遮罩(130)；工具栏其余控件
       (z-index:auto) 与背景伪元素(z-index:-1) 则被遮罩自然盖住，正好只露搜索框。 */
    '  body.pt-search-mode .miot-page > .player-toolbar { isolation:auto !important; }',
    /* 背景独立铺满视口，工具行按钮保持原位；上贴窗口顶，下贴下一行上沿（8px margin）。 */
    '  .miot-page > .player-toolbar::before { content:""; position:absolute;',
    '    z-index:-1; pointer-events:none;',
    '    top:calc(-10px - var(--sl-safe-top, 0px)) !important; bottom:-8px !important;',
    '    left:50% !important; transform:translateX(-50%) !important; width:100vw !important;',
    '    background:var(--md-secondary-container); }',
    /* 工具栏下缘发丝线：与歌曲列表行分割线同款（outline-variant 半透明 + scaleY(.5)），
       同样铺满视口；bottom:-8px 贴在淡紫背景底边上（补偿工具栏 margin-bottom）。 */
    '  .miot-page > .player-toolbar::after { content:""; position:absolute;',
    '    z-index:1; pointer-events:none;',
    '    bottom:-8px !important;',
    '    left:50% !important; transform:translateX(-50%) scaleY(.5) !important;',
    '    transform-origin:bottom; width:100vw !important; height:1px;',
    '    background:var(--md-outline-variant); opacity:.5; }',
    '  .miot-page > .player-toolbar > .toolbar-field {',
    '    flex:1 1 auto !important; width:auto !important; min-width:0 !important; }',
    /* 三个控件同高：歌单框与两个 40px 圆形按钮完全一致；
       展开搜索框用 inset:0 铺满工具行，高度自动跟着变成 40px */
    '  .miot-page > .player-toolbar > .toolbar-field .sl-select-trigger {',
    '    height:40px !important; min-height:40px !important; max-height:40px !important;',
    '    border-radius:999px !important; }',
    /* 「继续播放」→ 只留图标的圆形按钮 */
    '  .miot-page > .player-toolbar > .sl-button {',
    '    flex:0 0 40px !important; width:40px !important;',
    '    min-width:40px !important; max-width:40px !important;',
    '    height:40px !important; min-height:40px !important;',
    '    padding:0 !important; margin:0 !important;',
    '    border-radius:50% !important; overflow:hidden; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-button-label { display:none !important; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-icon { font-size:20px !important; }',
    /* 搜索 → 40px 圆形按钮，默认折叠为放大镜 */
    '  .miot-page > .player-toolbar > .search-bar {',
    '    flex:0 0 40px !important; width:40px !important; height:40px !important;',
    '    min-width:0 !important; margin:0 !important; padding:0 !important;',
    '    border-radius:50% !important; justify-content:center;',
    '    overflow:hidden; cursor:pointer; }',
    '  .miot-page > .player-toolbar > .search-bar > :not(:first-child) {',
    '    display:none !important; }',
    '  .miot-page > .player-toolbar > .search-bar > :first-child {',
    '    font-size:20px !important; flex:none; }',
    /* iOS 在 input 字号 <16px 时聚焦会自动放大页面，锁死 16px */
    '  .miot-page .search-bar input { font-size:16px !important; }',
    /* 二级页：搜索框保持胶囊形状 fixed 在左上，取消按钮独立 fixed 到右侧，
       结果面板铺满其下方；三者用同一组关键帧从左滑入（像页面 push 进来的动效）。 */
    '  body.pt-search-mode { overflow:hidden !important; }',
    '  .miot-page > .player-toolbar > .search-bar.pt-open {',
    '    position:fixed !important;',
    '    top:calc(10px + var(--sl-safe-top, 0px)) !important; left:12px !important;',
    /* 宽度在「左右 12px 边距 + 60px 取消按钮」基础上再减 10px，
       与右侧取消按钮之间留出可见间隙（原本两者边界精确贴合显拥挤）。 */
    '    right:auto !important; width:calc(100% - 24px - 60px - 10px) !important;',
    '    height:41px !important; min-height:41px !important;',
    '    min-width:0 !important; margin:0 !important; padding:0 14px !important;',
    '    border-radius:999px !important; align-items:center;',
    '    justify-content:flex-start; overflow:visible; z-index:141 !important;',
    '    cursor:default; gap:8px;',
    '    background:var(--md-surface-container-lowest, var(--md-surface)) !important;',
    '    border:1px solid var(--md-outline-variant) !important;',
    '    box-shadow:0 2px 10px #0001;',
    '    animation:pt-search-slide-in .28s cubic-bezier(.2,.8,.2,1) both; }',
    '  .miot-page > .player-toolbar > .search-bar.pt-open > :not(:first-child) {',
    '    display:flex !important; }',
    '  .miot-page > .player-toolbar > .search-bar.pt-open > input {',
    '    display:block !important; flex:1 !important; min-width:0; }',
    /* 取消按钮：胶囊右侧、独立 fixed，带描边，随二级页一起滑入 */
    '  .pt-search-cancel {',
    '    position:fixed !important; display:none !important;',
    '    top:calc(10px + var(--sl-safe-top, 0px)) !important; right:12px !important;',
    '    z-index:141 !important;',
    '    height:41px !important; min-height:41px !important; min-width:60px !important;',
    '    padding:0 12px !important;',
    '    border:1px solid var(--md-outline-variant) !important;',
    '    border-radius:999px !important;',
    '    background:var(--md-surface, #fff) !important;',
    '    color:var(--md-primary, #7c4dff) !important; font-size:14px !important;',
    '    font-weight:700 !important;',
    '    line-height:1 !important; appearance:none !important;',
    '    align-items:center; justify-content:center;',
    '    white-space:nowrap; cursor:pointer; }',
    '  body.pt-search-mode .pt-search-cancel {',
    '    display:inline-flex !important;',
    '    animation:pt-search-slide-in .28s cubic-bezier(.2,.8,.2,1) both; }',
    /* 二级页：结果面板顶栏下方铺满到屏幕底部（覆盖 placePanel 的行内定位） */
    '  body.pt-search-mode .pt-search-panel {',
    '    top:calc(64px + var(--sl-safe-top, 0px)) !important; bottom:0 !important;',
    '    left:0 !important; right:0 !important;',
    '    width:100% !important; height:auto !important; max-height:none !important;',
    '    border:0 !important; border-radius:0 !important; box-shadow:none !important;',
    '    background:var(--md-surface, #fff) !important; z-index:135 !important;',
    '    animation:pt-search-fade-in .3s ease both; }',
    '}',

    /* 方案A（全端，含电脑端）：把第二栏 AppBar 整栏收起，功能并入工具栏菜单。
       宿主应用层是第一栏（飞牛原生，动不了），这里只收我们自己那条 AppBar。
       2026-11-24：电脑端也采用此样式；菜单按钮图标换成状态灯前的紫色 miot 图标。 */
    '.miot-page > .player-toolbar { position:relative !important; }',
    '.miot-main-appbar { display:none !important; }',
    '.miot-page { padding-top:calc(10px + var(--sl-safe-top, 0px)) !important; }',
    '.miot-page > .player-toolbar > #pt-more {',
    '  flex:0 0 40px !important; width:40px !important; height:40px !important;',
    '  min-width:40px !important; max-width:40px !important;',
    '  padding:0 !important; margin:0 !important; border-radius:50% !important;',
    '  border:1px solid var(--md-outline) !important;',
    '  background:var(--md-surface-container-low) !important;',
    '  color:var(--md-on-surface) !important;',
    /* 图标在圆形底内水平+垂直居中 */
    '  display:flex !important; align-items:center !important;',
    '  justify-content:center !important; line-height:1 !important; }',
    '.miot-page > .player-toolbar > #pt-more svg { width:20px; height:20px; display:block; }',
    /* 紫色 miot 图标（PNG）作为菜单按钮图标，与状态灯前那个一致；缩小 20% */
    '.miot-page > .player-toolbar > #pt-more img { width:17.6px; height:17.6px;',
    '  display:block; object-fit:contain; pointer-events:none; }',
    ':root[data-theme="dark"] .miot-page > .player-toolbar > #pt-more img {',
    '  filter:brightness(1.3); }',
    '#pt-more-menu { position:absolute; top:calc(100% + 6px); right:0;',
    '  z-index:220; min-width:188px; padding:6px;',
    '  border:1px solid var(--md-outline-variant); border-radius:14px;',
    '  background:var(--md-surface-container-lowest, var(--md-surface));',
    '  box-shadow:0 8px 22px #0003; display:none; }',
    '#pt-more-menu.pt-open { display:block; }',
    '#pt-more-menu .pt-menu-status { display:flex; align-items:center;',
    '  padding:6px 12px 10px; margin-bottom:4px;',
    '  border-bottom:1px solid var(--md-outline-variant); }',
    /* 状态灯行与菜单项共用同一套两列基准：图标列 20px、列间距 12px、左右内边距 12px。
       这样紫色连接图标的中心 = 菜单图标中心，三个圆点的左缘 = 菜单文字左缘。 */
    '#pt-more-menu .pt-status { gap:12px; }',
    '#pt-more-menu .pt-conn { width:20px; height:20px; color:var(--md-on-surface); }',
    '#pt-more-menu .pt-conn img, #pt-more-menu .pt-conn svg { width:20px; height:20px; }',
    '#pt-more-menu .pt-dot-sm { top:0; }',
    '#pt-more-menu .pt-menu-item { display:flex; align-items:center; gap:12px;',
    '  width:100%; padding:11px 12px; border:0; border-radius:10px;',
    '  background:transparent; color:var(--md-on-surface);',
    '  font-size:14px; text-align:left; cursor:pointer; }',
    '#pt-more-menu .pt-menu-item:active {',
    '  background:var(--md-surface-container-high, #0001); }',
    '#pt-more-menu .pt-menu-item svg { width:20px; height:20px; flex:none;',
    '  stroke:currentColor; stroke-width:1.9; fill:none;',
    '  stroke-linecap:round; stroke-linejoin:round; }',

    /* ===== 触屏按压反馈：去掉灰色遮罩，改为按下时图标变主题色 ===== */
    '@media (max-width:719px), (hover:none) {',
    /* iOS / WKWebView 点击时默认的半透明蓝灰高亮块 */
    '  button, .sl-button, .icon-button, .btn-icon, .search-bar, [role="button"] {',
    '    -webkit-tap-highlight-color:transparent !important; }',
    /* 触屏点按会残留 sticky :hover，M3 原规则由此留下一层灰色圆底；
       实心/色调按钮本身靠背景色表意，必须排除，否则点完后背景被 !important 清成透明 */
    '  .sl-button:hover:not(:disabled):not(.bar-play-primary):not(.control-primary):not(.sl-button-filled):not(.sl-button-tonal),',
    '  .sl-button-text:hover:not(:disabled),',
    '  .player-bar .sl-button:hover:not(:disabled):not(.bar-play-primary):not(.control-primary):not(.sl-button-filled):not(.sl-button-tonal),',
    '  .icon-button:hover, .btn-icon:hover {',
    '    background:transparent !important; box-shadow:none !important; }',
    /* 主播放键是紫底白图标，保持底板，按下时改浅紫底 + 紫图标 */
    '  .sl-button.bar-play-primary:hover, .sl-button.control-primary:hover {',
    '    background:var(--md-primary) !important; box-shadow:var(--md-shadow-2) !important; }',
    '  .sl-button.bar-play-primary:active, .sl-button.bar-play-primary.pt-pressed,',
    '  .sl-button.control-primary:active, .sl-button.control-primary.pt-pressed {',
    '    background:var(--md-primary-container) !important; box-shadow:none !important; }',
    '  .sl-button:active .sl-icon, .sl-button.pt-pressed .sl-icon,',
    '  .icon-button:active .sl-icon, .icon-button.pt-pressed .sl-icon,',
    '  .btn-icon:active .sl-icon, .btn-icon.pt-pressed .sl-icon,',
    '  .search-bar:active .sl-icon, .search-bar.pt-pressed .sl-icon {',
    '    color:var(--md-primary) !important; }',
    '  .sl-button .sl-icon, .icon-button .sl-icon, .btn-icon .sl-icon,',
    '  .search-bar .sl-icon { transition:none !important; }',
    '}',

    /* ===== 手机档（<600）：避开屏幕圆角 / homebar ===== */
    '@media (max-width:599px) {',
    /* 列表本身保持原样（白底），只有播放条下方那条 homebar 填充区跟随横条专辑色。
       切勿给 .miot-page 整页铺渐变——会把整个歌曲列表都染色。 */ '  .miot-page.miot-page-with-player {',
    '    padding-bottom:20px !important;',
    '    background-image:linear-gradient(to bottom, transparent calc(100% - 20px),',
    '      var(--pt-bar-bg) calc(100% - 20px)) !important; }',
    '  .player-bar-shell {',
    '    bottom:calc(20px + var(--sl-safe-bottom, 0px)) !important; }',
    /* 底部填充层：与横条同款专辑色切片，palette 变量由 PlayerBar 同步到 :root。
       ::after 底边贴视口底、横条底边在其上方 20px+safe，两者 background-position
       统一用 center bottom 各自贴自身盒底，色带衔接处颜色连续。 */
    '  .miot-page.miot-page-with-player::after { content:""; position:fixed;',
    '    left:0; right:0; bottom:0;',
    '    height:calc(20px + var(--sl-safe-bottom, 0px));',
    '    background-image:',
    '      linear-gradient(var(--pt-bar-tint), var(--pt-bar-tint)),',
    '      radial-gradient(circle at 14% 10%, var(--player-palette-vibrant, rgb(230,227,247)) 0%, transparent 52%),',
    '      radial-gradient(circle at 88% 24%, var(--player-palette-dominant, rgb(230,227,247)) 0%, transparent 58%),',
    '      linear-gradient(155deg, var(--player-palette-dominant, rgb(230,227,247)),',
    '        var(--player-palette-dark, rgb(230,227,247))) !important;',
    '    background-size:100% 100%, 100vw 100vh, 100vw 100vh, 100vw 100vh !important;',
    '    background-position:center bottom !important;',
    '    background-repeat:no-repeat !important;',
    '    z-index:85; pointer-events:none; }',
    '  .fullscreen-controls-mobile .control-primary.sl-button {',
    '    width:60px !important; height:60px !important; min-height:60px !important; }',
    '  .fullscreen-controls-mobile .control-primary.sl-button .sl-icon {',
    '    font-size:28px !important; }',
    '  .fullscreen-playback {',
    '    bottom:calc(20px + var(--sl-safe-bottom, 0px)) !important; }',
    '  .fullscreen-layout {',
    '    padding-bottom:calc(248px + var(--sl-safe-bottom, 0px)) !important; }',
    '  .fullscreen-swipe-hint { display:none !important; }',
    '}',
    '@media (max-width:599px) and (max-height:650px) {',
    '  .fullscreen-layout {',
    '    padding-bottom:calc(222px + var(--sl-safe-bottom, 0px)) !important; }',
    '}',

    /* ===== 手机端搜索二级页：全屏遮罩 + 取消按钮 ===== */
    /* 二级页从左侧滑入的关键帧（搜索框胶囊 / 取消按钮 / 结果面板共用） */
    '@keyframes pt-search-slide-in {',
    '  from { transform:translateX(-100%); opacity:.4; }',
    '  to { transform:translateX(0); opacity:1; }',
    '}',
    '@keyframes pt-search-fade-in {',
    '  from { opacity:0; }',
    '  to { opacity:1; }',
    '}',
    /* 遮罩 append 到 body（不在 #app 内），不会触发 MutationObserver→mount 循环 */
    '.pt-search-mask { position:fixed; inset:0; z-index:130; display:none;',
    '  background:var(--md-surface, #fff); }',
    '.pt-search-mask.show { display:block; }',
    /* 取消按钮默认隐藏；仅手机端二级页展开态显示（见下方 media 规则） */
    '.pt-search-cancel { display:none !important; }',

    /* ===== 飞牛音乐搜索结果面板（点击即播） ===== */
    '.pt-search-panel { position:fixed; z-index:120; display:none;',
    '  overflow-y:auto; overscroll-behavior:contain;',
    '  border:1px solid var(--md-outline-variant); border-radius:16px;',
    '  background:var(--md-surface-container-lowest, var(--md-surface));',
    '  color:var(--md-on-surface); box-shadow:0 12px 32px #0003;',
    '  font-size:13px; line-height:1.4; }',
    '.pt-search-panel.show { display:block; }',
    '.pt-search-head { position:sticky; top:0; z-index:1; padding:10px 14px;',
    '  font-size:12px; color:var(--md-on-surface-variant);',
    '  background:inherit; border-bottom:1px solid var(--md-outline-variant); }',
    '.pt-search-row { display:flex; align-items:center; gap:9px;',
    '  padding:9px 14px; cursor:pointer; outline:none;',
    '  border-bottom:1px solid var(--md-outline-variant); }',
    '.pt-search-row:last-child { border-bottom:0; }',
    '.pt-search-row:hover, .pt-search-row:focus {',
    '  background:var(--md-surface-container-high, #0001); }',
    '.pt-search-row .pt-s-title { flex:1 1 auto; min-width:0;',
    '  overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }',
    '.pt-search-row .pt-s-artist { flex:0 1 34%; min-width:0;',
    '  overflow:hidden; white-space:nowrap; text-overflow:ellipsis;',
    '  color:var(--md-on-surface-variant); }',
    '.pt-search-row .pt-s-dur { flex:none; font-variant-numeric:tabular-nums;',
    '  color:var(--md-on-surface-variant); }',
    '.pt-search-online { flex:none; font-size:10px; padding:1px 5px;',
    '  border-radius:6px; background:var(--md-primary-container, #e9e0ff);',
    '  color:var(--md-on-primary-container, #4b3f8f); }',
    '.pt-search-empty { padding:20px 14px; text-align:center;',
    '  color:var(--md-on-surface-variant); }',
    '.miot-page.pt-searching .song-list { opacity:.35; pointer-events:none; }',
    /* 电脑端：在线结果内联到本地列表下方（普通文档流），上边缘紧贴本地结果下边缘、
       用直角边框（圆角上缘会被本地列表盖住）。并预留滚动条槽位，避免面板显示/隐藏时
       页面宽度变化导致左右跳动。搜索时列表容器收缩到内容高度，面板才能紧跟本地结果。 */
    '@media (min-width:720px) {',
    /* html 滚动条改为不占位：移除 scrollbar-gutter 预留的 10px 槽位。
       该槽位由浏览器绘制、内容无法覆盖，导致工具栏淡紫背景与播放条专辑色
       在视口右侧被截断露出底色。滚动条不占宽度后，通栏背景铺满整个视口；
       且页面变长/变短时宽度恒定，搜索面板显示/隐藏不会左右跳动。 */
    '  html { scrollbar-gutter:auto; scrollbar-width:none; }',
    '  html::-webkit-scrollbar { display:none; width:0; height:0; }',
    '  .pt-search-panel { position:static !important; z-index:auto !important;',
    '    width:auto !important; max-height:none !important;',
    /* 上边缘紧贴本地结果列表下边缘（取消原 12px 间隙），避免圆角边框被本地行盖住。 */
    '    margin:0 !important; overflow:visible !important;',
    /* 直角边框：与本地列表的直角卡片风格统一，贴合处不留弧形缺口。 */
    '    border:1px solid var(--md-outline-variant) !important;',
    '    border-radius:0 !important; box-shadow:none !important; }',
    '  .miot-page.pt-searching .song-list { opacity:1 !important; pointer-events:auto !important; }',
    '  .miot-page.pt-searching .sl-list-view { height:auto !important; overflow:visible !important; }',
    '}',
  ].join('\n');

  var style = document.createElement('style');
  style.id = 'pt-style';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  /* ------------------------------------------- 显示比例固定 100%（清掉旧偏好） */
  try { localStorage.removeItem(ZOOM_KEY); } catch (e) { /* ignore */ }
  try {
    var root = document.documentElement;
    if ('zoom' in root.style) root.style.zoom = '100%';
  } catch (e) { /* ignore */ }
  var zoomFactor = 1;

  /* 锁死页面缩放：iOS 在输入框字号 <16px 时聚焦会自动放大页面，
     CSS 已把搜索输入固定为 16px；这里再收紧 viewport 并禁用双指缩放手势。 */
  (function () {
    // 只在手机 / 窄屏上收紧：桌面浏览器保留用户自发的缩放能力
    if (window.innerWidth > 719
        && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      (document.head || document.documentElement).appendChild(meta);
    }
    meta.setAttribute('content',
      'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, '
      + 'user-scalable=no, viewport-fit=cover');
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); },
      { passive: false });
  })();

  /* ------------------------------------------------------------------ 图标 */
  var ICON_SUN = '<circle cx="12" cy="12" r="5"></circle>'
    + '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41'
    + 'M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>';
  var ICON_MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>';

  function svgEl(paths, id) {
    var wrap = document.createElement('span');
    wrap.innerHTML = '<svg id="' + id + '" viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    return wrap.firstChild;
  }

  /* ------------------------------------------------------------ 自建元素 */
  var statusEl = document.createElement('span');
  statusEl.className = 'pt-status';
  statusEl.id = 'pt-status';
  var connEl = document.createElement('span');
  connEl.className = 'pt-conn';
  connEl.id = 'pt-conn';
  // 音箱图标：与设置页「设备」项同款，内联 SVG + currentColor 填充，
  // 颜色随主题跟随 --md-on-surface，和菜单下方四个图标一致。不设 title，不吃指针事件。
  var connSvgWrap = document.createElement('span');
  connSvgWrap.setAttribute('aria-hidden', 'true');
  connSvgWrap.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" '
    + 'stroke="none" aria-hidden="true"><path d="' + SPEAKER_PATHS + '"></path></svg>';
  connEl.appendChild(connSvgWrap.firstChild);
  statusEl.appendChild(connEl);
  function newDot(id, tip) {
    var d = document.createElement('span');
    d.className = 'pt-dot-sm';
    d.id = id;
    d.title = tip;
    statusEl.appendChild(d);
    return d;
  }
  var speakerDot = newDot('pt-speaker-dot', '智能音箱·状态检查中…');
  var controlDot = newDot('pt-control-dot', '控制层·状态检查中…');
  var libDot = newDot('pt-lib-dot', '曲库·状态检查中…');

  var themeEl = document.createElement('button');
  themeEl.type = 'button';
  themeEl.id = 'pt-theme';
  themeEl.className = 'sl-button sl-button-icon pt-theme-inline';
  themeEl.setAttribute('aria-label', '切换主题');
  themeEl.title = '切换主题（Alt+T）';
  var content = document.createElement('span');
  content.className = 'sl-button-content';
  content.appendChild(svgEl(ICON_SUN, 'pt-theme-icon'));
  themeEl.appendChild(content);

  var toastEl = document.createElement('div');
  toastEl.className = 'pt-toast';
  toastEl.setAttribute('role', 'status');
  (document.body || document.documentElement).appendChild(toastEl);

  function toast(msg) {
    toastEl.textContent = msg;
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }
  toastEl.addEventListener('click', function () { toastEl.classList.remove('show'); });

  /* ------------------------------------------ 手机端工具行 ⋮ 菜单（方案A）
     把原第二栏 AppBar 的设备/刷新/设置/主题四项收进一个圆形 ⋮ 按钮。
     菜单项点击时直接 .click() 原 AppBar 里的 Vue 按钮，复用其事件处理；
     主题项直接触发 themeEl。状态灯 statusEl 也会在 mount() 里移到菜单顶部。 */
  var ICON_MORE = '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none">'
    + '</circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none">'
    + '</circle><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"></circle>';
  var ICON_DEVICE = '<rect x="3" y="4" width="15" height="16" rx="2"></rect>'
    + '<path d="M20 9v6M6 8h6M6 12h6M6 15h4"></path>';
  var ICON_REFRESH = '<path d="M21 12a9 9 0 1 1-2.64-6.36"></path>'
    + '<path d="M21 3v6h-6"></path>';
  var ICON_SETTINGS = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25'
    + 'a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1'
    + 'a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38'
    + 'a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44'
    + 'a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73'
    + 'l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09'
    + 'a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25'
    + 'a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>'
    + '<circle cx="12" cy="12" r="3"></circle>';

  var moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.id = 'pt-more';
  moreBtn.className = 'pt-more-btn';
  moreBtn.setAttribute('aria-label', '更多操作');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.title = '更多操作';
  // 图标换成状态灯前那个紫色 miot 图标（与连接图标同源），不再用三个点
  var moreImg = document.createElement('img');
  moreImg.src = CONN_PNG;
  moreImg.alt = '';
  moreImg.setAttribute('aria-hidden', 'true');
  moreBtn.appendChild(moreImg);

  var moreMenu = document.createElement('div');
  moreMenu.id = 'pt-more-menu';
  moreMenu.className = 'pt-more-menu';
  moreMenu.setAttribute('role', 'menu');
  var menuStatus = document.createElement('div');
  menuStatus.className = 'pt-menu-status';
  moreMenu.appendChild(menuStatus);
  function addMenuItem(act, iconPaths, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pt-menu-item';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('data-act', act);
    b.appendChild(svgEl(iconPaths, 'pt-menuitem-icon-' + act));
    var t = document.createElement('span');
    t.textContent = label;
    b.appendChild(t);
    moreMenu.appendChild(b);
  }
  addMenuItem('theme', ICON_SUN, '切换主题');
  addMenuItem('device', ICON_DEVICE, '选择设备');
  addMenuItem('refresh', ICON_REFRESH, '刷新');
  addMenuItem('settings', ICON_SETTINGS, '设置');

  function setToolbarMenuOpen(open) {
    var tb = moreBtn.closest ? moreBtn.closest('.player-toolbar') : null;
    if (tb) tb.classList.toggle('pt-menu-open', open);
  }
  function closeMoreMenu() {
    moreMenu.classList.remove('pt-open');
    setToolbarMenuOpen(false);
    moreBtn.setAttribute('aria-expanded', 'false');
  }
  moreBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = !moreMenu.classList.contains('pt-open');
    moreMenu.classList.toggle('pt-open', open);
    setToolbarMenuOpen(open);
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  moreMenu.addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('.pt-menu-item') : null;
    if (!item) return;
    e.stopPropagation();
    var act = item.getAttribute('data-act');
    if (act === 'theme') {
      themeEl.click();
    } else {
      var titleMap = { device: '选择设备', refresh: '刷新', settings: '设置' };
      var btn = document.querySelector('.miot-main-appbar .appbar-actions [title="' + titleMap[act] + '"]');
      if (btn) btn.click();
    }
    closeMoreMenu();
  });
  document.addEventListener('pointerdown', function (e) {
    if (!moreMenu.classList.contains('pt-open')) return;
    if (moreBtn.contains(e.target) || moreMenu.contains(e.target)) return;
    closeMoreMenu();
  }, true);

  /* ================================================ 飞牛音乐搜索（与语音点播同源）
     后端 /compat/library-search?full=1 调的是 music.searchSongs()，也就是上午
     语音点播接入的那条飞牛音乐 /music/api/v1/search/track（ext 在位时合并在线音源）。
     register() 已建立 id -> guid 映射，返回的 play_url 可直接交给 /mina/play-url。
     面板是独立的固定定位浮层，不去改 Vue 的 state.songs，避免被虚拟列表重渲染覆盖。 */
  var panel = document.createElement('div');
  panel.className = 'pt-search-panel';
  panel.id = 'pt-search-panel';
  (document.body || document.documentElement).appendChild(panel);

  var searchSeq = 0;
  var searchTimer = 0;
  var searchResults = [];

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDur(sec) {
    var n = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(n / 60) + ':' + ('0' + (n % 60)).slice(-2);
  }
  function searchBarEl() {
    return document.querySelector('.miot-page > .player-toolbar > .search-bar');
  }
  function placePanel(bar) {
    var small = window.innerWidth < 720;
    // 电脑端面板内联在本地列表下方（普通文档流），不要行内 fixed 定位残留
    if (!small) {
      panel.style.removeProperty('left');
      panel.style.removeProperty('top');
      panel.style.removeProperty('width');
      panel.style.removeProperty('max-height');
      return;
    }
    var r = bar.getBoundingClientRect();
    var w = Math.max(240, window.innerWidth - 24);
    w = Math.min(w, window.innerWidth - 16);
    var left = 12;
    var top = Math.max(8, r.bottom + 6);
    var maxH = Math.max(160, window.innerHeight - top - 96);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = top + 'px';
    panel.style.width = w + 'px';
    panel.style.maxHeight = maxH + 'px';
  }
  function hidePanel() {
    panel.classList.remove('show');
    var p = document.querySelector('.miot-page');
    if (p) p.classList.remove('pt-searching');
  }
  function onSearchInput() {
    var bar = searchBarEl();
    var inp = bar && bar.querySelector('input');
    var q = inp ? String(inp.value || '').trim() : '';
    clearTimeout(searchTimer);
    if (!q || !bar) { searchSeq++; hidePanel(); return; }
    placePanel(bar);
    panel.innerHTML = '<div class="pt-search-head">正在搜索飞牛音乐…</div>';
    panel.classList.add('show');
    var page = document.querySelector('.miot-page');
    if (page) page.classList.add('pt-searching');
    searchTimer = setTimeout(function () { doSearch(q); }, 280);
  }
  function doSearch(q) {
    var seq = ++searchSeq;
    fetchJson(apiUrl('/compat/library-search?q=' + encodeURIComponent(q) + '&full=1'))
      .then(function (d) {
        if (seq !== searchSeq) return;
        // 桌面端上方原生列表已有带封面的本地匹配，面板只留在线音源避免重复；
        // 手机端原生列表不展示本地匹配，这里保留接口返回的本地歌曲。
        var rows = (d && d.songs) || [];
        searchResults = isPhoneWidth() ? rows : rows.filter(function (s) {
          return !!(s && s.is_online);
        });
        renderResults(d);
      })
      .catch(function (e) {
        if (seq !== searchSeq) return;
        panel.innerHTML = '<div class="pt-search-empty">搜索失败：'
          + escapeHtml(String((e && e.message) || e)) + '</div>';
      });
  }
  function renderResults(d) {
    var n = searchResults.length;
    var phone = isPhoneWidth();
    var online = phone && d && d.online ? '（在线 ' + d.online + '）' : '';
    var head = '<div class="pt-search-head">飞牛音乐 · ' + n + ' 首'
      + online + ' · 点击即播</div>';
    if (!n) {
      panel.innerHTML = head + '<div class="pt-search-empty">'
        + (phone ? '没有匹配的歌曲' : '没有匹配的在线歌曲') + '</div>';
      return;
    }
    var html = [head];
    for (var i = 0; i < n; i++) {
      var s = searchResults[i];
      html.push('<div class="pt-search-row" data-pt-idx="' + i
        + '" role="button" tabindex="0">'
        + '<span class="pt-s-title">' + escapeHtml(s.title) + '</span>'
        + (s.is_online ? '<span class="pt-search-online">在线</span>' : '')
        + '<span class="pt-s-artist">' + escapeHtml(s.artist) + '</span>'
        + '<span class="pt-s-dur">' + fmtDur(s.duration) + '</span>'
        + '</div>');
    }
    panel.innerHTML = html.join('');
  }
  function playSearchSong(s, row) {
    if (!s || !s.play_url || row.getAttribute('data-pt-busy')) return;
    row.setAttribute('data-pt-busy', '1');
    row.style.opacity = '.55';
    fetchJson(apiUrl('/mina/devices'))
      .then(function (d) {
        var t = firstDevice(d && d.data);
        if (!t.device) throw new Error('没有可用的智能音箱');
        var id = t.device.deviceID || t.device.deviceId;
        // 走 /player/play-online：把歌曲加载进播放队列再推流，音箱播放的 URL 不变，
        // 但 /player/status 的 current_song 会同步更新，下方播放器信息跟着变。
        return fetch(apiUrl('/player/play-online'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account_id: t.account,
            device_id: id,
            url: s.play_url,
            title: s.title || '',
            artist: s.artist || '',
            cover_url: s.cover_url || s.cover || '',
            duration: s.duration || 0,
          }),
        }).then(function (r) { return r.json(); });
      })
      .then(function (r) {
        row.removeAttribute('data-pt-busy');
        row.style.opacity = '';
        if (!r || r.success === false) throw new Error((r && r.error) || '播放失败');
        toast('已播放：' + s.title + (s.artist ? ' · ' + s.artist : ''));
      })
      .catch(function (e) {
        row.removeAttribute('data-pt-busy');
        row.style.opacity = '';
        toast('播放失败：' + String((e && e.message) || e));
      });
  }
  panel.addEventListener('click', function (e) {
    var row = e.target && e.target.closest ? e.target.closest('.pt-search-row') : null;
    if (row) playSearchSong(searchResults[Number(row.getAttribute('data-pt-idx'))], row);
  });
  panel.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target && e.target.closest ? e.target.closest('.pt-search-row') : null;
    if (row) {
      e.preventDefault();
      playSearchSong(searchResults[Number(row.getAttribute('data-pt-idx'))], row);
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('.miot-page .search-bar input')) onSearchInput();
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target;
    var bar = searchBarEl();
    // Vue 的「清除搜索」按钮是程序化改 value，不会派发 input 事件
    if (bar && bar.contains(t) && t.closest && t.closest('button')) {
      setTimeout(function () {
        var inp = bar.querySelector('input');
        if (!inp || !String(inp.value || '').trim()) hidePanel();
      }, 80);
    }
    if (!panel.classList.contains('show')) return;
    if (panel.contains(t)) return;
    if (bar && (bar === t || bar.contains(t))) return;
    // 桌面端在线结果已内联在本地列表下方，属于页面内容的一部分：点空白处
    // 不该让它消失（只有清空搜索词才收起）。手机端二级页仍按「点外部收起」处理。
    if (!isPhoneWidth()) return;
    hidePanel();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    hidePanel();
    // 二级页展开时，Escape 也收起二级页回到上一级（与「取消」按钮等价）
    if (searchOpen) closeSearchPage(isPhoneWidth());
  });
  window.addEventListener('resize', function () {
    if (!panel.classList.contains('show')) return;
    var bar = searchBarEl();
    if (bar) placePanel(bar);
  });
  window.addEventListener('scroll', function () {
    if (!panel.classList.contains('show')) return;
    // 电脑端面板已内联在列表下方，随文档正常滚动，不做悬浮层的滚动收起
    if (!isPhoneWidth()) return;
    var bar = searchBarEl();
    if (!bar || bar.getBoundingClientRect().bottom < 48) { hidePanel(); return; }
    placePanel(bar);
  }, true);


  /* ------------------------------------------------- 挂到面板应用栏（幂等） */
  var lastCtlW = 168;
  var lastWidthApplied = 0;
  var searchOpen = false;

  // 手机端搜索二级页的全屏遮罩：盖住主界面，点遮罩空白＝点外部，走下方收起逻辑。
  // append 到 body（不在 #app 内），避免被 MutationObserver→mount 观察到而形成循环。
  var searchMask = document.createElement('div');
  searchMask.className = 'pt-search-mask';
  searchMask.id = 'pt-search-mask';
  (document.body || document.documentElement).appendChild(searchMask);

  // 二级页「取消」按钮：独立挂 body（不能放进带 transform 动画的搜索框，
  // 否则它的 fixed 定位会被 transform 劫持）。只在手机端二级页显示。
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'pt-search-cancel';
  cancelBtn.id = 'pt-search-cancel';
  cancelBtn.textContent = '取消';
  cancelBtn.setAttribute('aria-label', '取消搜索');
  cancelBtn.addEventListener('click', function (e) {
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    closeSearchPage(true);
  });
  (document.body || document.documentElement).appendChild(cancelBtn);

  function isPhoneWidth() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 719px)').matches);
  }

  function syncSearchWidth(toolbar) {
    // 桌面搜索框宽度固定 240px（原 120px 加倍）；「继续播放」已是 44px 圆钮，
    // 不能再拿按钮实宽当基准。清掉旧版遗留的行内变量即可。
    if (toolbar) toolbar.style.removeProperty('--pt-ctl-w');
  }

  function clearPlaceholder(search) {
    var inputs = search.querySelectorAll('input, textarea');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].getAttribute('placeholder')) {
        inputs[i].setAttribute('placeholder', '');
      }
    }
  }

  /* 手机端：点圆形搜索按钮进入全屏二级页；桌面端：仅保持搜索框常驻。
     applySearchState 统一维护展开态 class + 遮罩 + body 标记，二者互斥不会串到桌面。 */
  function applySearchState(focus) {
    var s = document.querySelector('.miot-page .search-bar');
    var tb = s ? (s.closest ? s.closest('.player-toolbar') : s.parentNode) : null;
    var phone = isPhoneWidth();
    // pt-open / pt-search-open 两端通用（bindSearch 的点击判断依赖 pt-open），桌面端行为不变
    if (s) s.classList.toggle('pt-open', searchOpen);
    if (tb) tb.classList.toggle('pt-search-open', searchOpen);
    // 遮罩与 body 标记只在手机端生效，桌面端搜索框常驻、不受影响
    if (searchMask) searchMask.classList.toggle('show', searchOpen && phone);
    if (document.body) document.body.classList.toggle('pt-search-mode', searchOpen && phone);
    if (searchOpen && focus) {
      var inp = s && s.querySelector('input');
      if (inp) setTimeout(function () { try { inp.focus(); } catch (e) { /* ignore */ } }, 0);
    }
  }
  /* 关闭二级页（取消 / 放大镜 / 点外部 / Escape 共用）：
     除了收起页面、收回软键盘，还要清空输入与上次搜索结果，避免下次进来残留旧内容。
     输入清空用原生 input 事件回写，让 SlInput 触发 update:modelValue 同步 Vue 的
     state.songSearch，否则 Vue 重渲染会把值填回去。 */
  function closeSearchPage(clearSession) {
    // 清空输入与结果：取消按钮 / 手机端各关闭路径需要；桌面端只收起、不清空。
    if (clearSession) {
      var s = document.querySelector('.miot-page .search-bar');
      var inp = s && s.querySelector('input');
      if (inp) {
        try { inp.blur(); } catch (err) { /* ignore */ }
        inp.value = '';
        try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (err) { /* ignore */ }
      }
      clearTimeout(searchTimer);
      searchSeq++;
      searchResults = [];
      if (panel) panel.innerHTML = '';
    }
    hidePanel();
    searchOpen = false;
    applySearchState(false);
  }
  function bindSearch(search) {
    if (search.getAttribute('data-pt-bound')) return;
    search.setAttribute('data-pt-bound', '1');
    search.addEventListener('click', function (e) {
      if (search.classList.contains('pt-open')) {
        // 展开态：再点第一个子元素（放大镜图标）即收起，输入框失焦以收回软键盘。
        // 点输入框内容区 / 清除 / 定位按钮不收起，交给各自逻辑处理。
        var first = search.firstElementChild;
        if (first && (e.target === first || first.contains(e.target))) {
          closeSearchPage(true);
        }
        return;
      }
      searchOpen = true;
      applySearchState(true);
      setTimeout(function () {
        var inp = search.querySelector('input');
        if (inp && String(inp.value || '').trim()) onSearchInput();
      }, 40);
    });
  }
  document.addEventListener('click', function (e) {
    if (!searchOpen) return;
    // 取消按钮独立挂在 body 上，由它自己的 handler 处理（含清空），这里必须放行
    if (cancelBtn && (e.target === cancelBtn || cancelBtn.contains(e.target))) return;
    var s = document.querySelector('.miot-page .search-bar');
    if (s && (e.target === s || s.contains(e.target))) return;
    // 搜索结果浮层属于搜索功能本身，点这里是要点歌，不能被当成「点外面」吞掉
    if (panel && panel.contains(e.target)) return;
    var isPhone = !!(window.matchMedia
      && window.matchMedia('(max-width: 719px)').matches);
    // 桌面端搜索框常驻、在线结果内联成页面内容：点外部只退出展开态，
    // 绝不 hidePanel（否则在线结果消失、再点搜索框又重现）。
    if (!isPhone) {
      searchOpen = false;
      applySearchState(false);
      return;
    }
    // 手机端：点搜索框以外任何地方，收起并清空会话，同时吞掉这一次点击，
    // 避免连带激活被点元素的原有功能（播放/切歌/打开面板等）。
    closeSearchPage(true);
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
  }, true);

  function handleChatActivity() {
    var el = document.querySelector('.chat-activity');
    if (!el) return;
    var stale = (el.textContent || '').indexOf('播报结束未确认') >= 0;
    el.classList.toggle('pt-stale', stale);
    if (stale) clearStaleChat();
  }

  function mount() {
    var toolbar = document.querySelector('.miot-page > .player-toolbar');
    // 设置页 / 全屏播放页没有工具行：不挂按钮、不显示状态灯。
    if (!toolbar) {
      closeMoreMenu();
      return;
    }

    // 状态灯全端进菜单顶部（AppBar 在手机/电脑端都已隐藏）。
    if (statusEl.parentNode !== menuStatus) menuStatus.appendChild(statusEl);

    // 搜索结果面板：电脑端内联到本地歌曲列表容器的末尾（普通文档流，紧跟列表），
    // 手机端留在 body 配合二级页遮罩。Vue 会重渲染 .song-list，故每次 mount 幂等纠正。
    var songList = document.querySelector('.miot-page .song-list');
    if (!isPhoneWidth() && songList) {
      if (panel.parentNode !== songList || panel !== songList.lastElementChild) {
        songList.appendChild(panel);
      }
    } else {
      var body = document.body || document.documentElement;
      if (panel.parentNode !== body) body.appendChild(panel);
    }

    // 搜索栏原本是 .miot-page 的独立一行，搬到工具行（幂等，避免重复绑定/失焦）。
    var search = document.querySelector('.miot-page .search-bar');
    if (search) {
      if (search.parentNode !== toolbar) toolbar.appendChild(search);
      syncSearchWidth(toolbar);
      clearPlaceholder(search);
      bindSearch(search);
      applySearchState(false);
    }

    // 菜单按钮 + 菜单挂到工具行，紧跟在搜索框后面（手机 / 电脑端统一）。
    if (moreBtn.parentNode !== toolbar) toolbar.appendChild(moreBtn);
    if (moreMenu.parentNode !== toolbar) toolbar.appendChild(moreMenu);
    if (search && search.parentNode === toolbar) {
      if (search.nextElementSibling !== moreBtn) {
        toolbar.insertBefore(moreBtn, search.nextSibling);
      }
      if (moreBtn.nextElementSibling !== moreMenu) {
        toolbar.insertBefore(moreMenu, moreBtn.nextSibling);
      }
    }

    // 「继续播放」圆钮移到歌单选择框之前。Vue 的 v-if 锚点会把它插回
    // .toolbar-field 之后，所以每次 mount 都幂等纠正一次；桌面 / 手机端
    // 统一为「继续播放 / 歌单选择器 / 搜索 / 菜单按钮」。
    var resume = toolbar.querySelector(':scope > .sl-button');
    var field = toolbar.querySelector(':scope > .toolbar-field');
    if (resume && field && field.previousElementSibling !== resume) {
      toolbar.insertBefore(resume, field);
    }
    // 歌单下拉面板（.sl-select-panel-fixed，z-index:300）被工具栏 isolation 困住，
    // 工具栏自身 z-index:auto 时会被下方歌曲列表行盖住、点不到。下拉打开期间同步
    // pt-select-open 提升工具栏层级，关闭即撤销（与菜单 pt-menu-open 同一手法）。
    var fieldOpen = !!(field && field.querySelector('.sl-select-panel'));
    toolbar.classList.toggle('pt-select-open', fieldOpen);
    handleChatActivity();
  }
  mount();

  /* iOS 上纯 CSS :active 需要元素先有 touchstart 监听才可靠触发；这里用
     .pt-pressed 类兜底，松开后延时移除，保证按下反馈看得见。CSS 只在
     触屏 / 窄屏生效，桌面不受影响。 */
  (function () {
    var pressed = [];
    function clear() {
      for (var i = 0; i < pressed.length; i++) {
        try { pressed[i].classList.remove('pt-pressed'); } catch (e) { /* ignore */ }
      }
      pressed = [];
    }
    function hit(e) {
      var t = e.target;
      if (!t || !t.closest) return null;
      return t.closest('button, .sl-button, .icon-button, .btn-icon, '
        + '.search-bar, [role="button"]');
    }
    function down(e) {
      var el = hit(e);
      if (!el) return;
      clear();
      el.classList.add('pt-pressed');
      pressed = [el];
    }
    function up() { setTimeout(clear, 110); }
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', clear, true);
    document.addEventListener('touchstart', down, true);
    document.addEventListener('touchend', up, true);
    document.addEventListener('touchcancel', clear, true);
  })();

  if (window.MutationObserver) {
    var appRoot = document.getElementById('app') || document.body;
    new MutationObserver(mount).observe(appRoot, { childList: true, subtree: true });
  } else {
    setInterval(mount, 800);
  }

  /* ------------------------------------------------------------------ 主题 */
  function readPref() {
    var v = null;
    try { v = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    return (v === 'light' || v === 'dark') ? v : 'auto';
  }
  function resolvedTheme() {
    var p = readPref();
    if (p === 'light' || p === 'dark') return p;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }
  function paintTheme() {
    var theme = resolvedTheme();
    document.documentElement.setAttribute('data-theme', theme);
    var icon = themeEl.querySelector('#pt-theme-icon');
    if (icon) icon.innerHTML = theme === 'dark' ? ICON_MOON : ICON_SUN;
    var pref = readPref();
    themeEl.title = '主题：' + (pref === 'auto' ? '跟随系统'
      : (pref === 'dark' ? '暗色' : '亮色')) + '（点击切换，Alt+T）';
  }
  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(readPref()) + 1) % order.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    paintTheme();
    toast(next === 'auto' ? '主题：跟随系统' : (next === 'dark' ? '主题：暗色' : '主题：亮色'));
  }
  paintTheme();
  themeEl.addEventListener('click', cycleTheme);
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSys = function () { if (readPref() === 'auto') paintTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
  window.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey) return;
    if ((e.key || '').toLowerCase() === 't') { e.preventDefault(); cycleTheme(); }
  });

  /* ------------------------------------------------------------ 状态圆点 a/b/c */
  function mark(dot, color) {
    dot.className = 'pt-dot-sm' + (color ? ' ' + color : '');
  }
  function tip(dot, text) { if (dot.title !== text) dot.title = text; }

  function fetchJson(url, opts) {
    return fetch(url, opts || { credentials: 'same-origin' })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
      });
  }

  /* a: 音箱连接状态 —— 红=断开 / 蓝=待机 / 绿=播放中 */
  var lastChatClear = 0;
  function firstDevice(list) {
    var group, devs, i, j, acc = '', dev = null;
    for (i = 0; i < (list || []).length; i++) {
      group = list[i];
      devs = group.devices || [];
      for (j = 0; j < devs.length; j++) {
        if (!dev || devs[j].managed) { acc = group.account_id; dev = devs[j]; }
        if (devs[j].managed) break;
      }
      if (dev && dev.managed) break;
    }
    return { account: acc, device: dev };
  }

  function refreshSpeaker() {
    return fetchJson(apiUrl('/mina/devices'))
      .then(function (d) {
        var t = firstDevice(d && d.data);
        if (!t.device || t.device.presence === 'offline') {
          mark(speakerDot, 'red');
          tip(speakerDot, '智能音箱·断开');
          return t;
        }
        var id = t.device.deviceID || t.device.deviceId;
        return fetchJson(apiUrl('/player/status?account_id=' + encodeURIComponent(t.account)
          + '&device_id=' + encodeURIComponent(id)))
          .then(function (p) {
            var s = (p && p.data) || {};
            var playing = p && p.success !== false
              && (s.is_playing === true || s.state === 'playing');
            mark(speakerDot, playing ? 'green' : 'blue');
            tip(speakerDot, playing ? '智能音箱·播放中' : '智能音箱·待机');
          })
          .catch(function () {
            mark(speakerDot, 'red');
            tip(speakerDot, '智能音箱·断开');
          })
          .then(function () { return t; });
      })
      .catch(function () {
        mark(speakerDot, 'red');
        tip(speakerDot, '智能音箱·断开');
        return { account: '', device: null };
      });
  }

  /* b: 控制层在线 / 断开；c: 曲库已索引 / 未连接 */
  function refreshIndex() {
    return fetchJson(apiUrl('/indexing/status'))
      .then(function (d) {
        var online = d && d.success !== false;
        mark(controlDot, online ? 'green' : 'red');
        tip(controlDot, online ? '控制层·在线' : '控制层·断开');
        var s = (d && d.data) || {};
        var n = Number(s.song_count || 0);
        var ready = !!s.ready && n > 0;
        mark(libDot, ready ? 'green' : 'red');
        tip(libDot, '曲库' + n + '首·' + (ready ? '已索引' : '未连接'));
      })
      .catch(function () {
        mark(controlDot, 'red');
        tip(controlDot, '控制层·断开');
        mark(libDot, 'red');
        tip(libDot, '曲库0首·未连接');
      });
  }

  function refreshStatus() {
    refreshIndex();
    refreshSpeaker();
  }

  /* 播报结束未确认（phase=unknown）是终态，会一直挂在顶部。
     顺手调 /chat/cancel 把它清成 cancelled，避免设置页也一直显示残留。 */
  function clearStaleChat() {
    var now = Date.now();
    if (now - lastChatClear < 30000) return;
    lastChatClear = now;
    fetchJson(apiUrl('/mina/devices'))
      .then(function (d) {
        var t = firstDevice(d && d.data);
        if (!t.device) return null;
        var id = t.device.deviceID || t.device.deviceId;
        return fetch(apiUrl('/chat/cancel'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account_id: t.account, device_id: id,
            close_session: false, resume_music: false,
          }),
        });
      })
      .catch(function () { /* 清理失败也不要影响页面 */ });
  }

  refreshStatus();
  setInterval(refreshStatus, 30000);
})();
