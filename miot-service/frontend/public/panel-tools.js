/* panel-tools.js
 * 面板轻量改造（不重建 Vue bundle，只注入 CSS + 少量 DOM）：
 *  - 显示比例固定 100%（不再沿用旧的 115% 缩放偏好）；
 *  - 顶栏原「Miot小爱音箱 / 智能音箱 · 待机」两行文字全部隐去，改为
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
  var CONN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyZpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTM4IDc5LjE1OTgyNCwgMjAxNi8wOS8xNC0wMTowOTowMSAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTcgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOkVFNTBBQjQyREQwMDExRjE5OEUxODczQUVEQkYxQ0JCIiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOkVFNTBBQjQzREQwMDExRjE5OEUxODczQUVEQkYxQ0JCIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6RUU1MEFCNDBERDAwMTFGMTk4RTE4NzNBRURCRjFDQkIiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6RUU1MEFCNDFERDAwMTFGMTk4RTE4NzNBRURCRjFDQkIiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz5wJoLPAAAJMklEQVR42uyd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';

  /* ------------------------------------------------------------------ 样式 */
  var CSS = [
    ':root { --pt-red:#d92d20; --pt-blue:#2563eb; --pt-green:#12805c;',
    '  --pt-idle:#8a8f98; --pt-bar-bg:#f8f8fc; }',
    ':root[data-theme="dark"] { --pt-red:#ff9d95; --pt-blue:#8ab4f8;',
    '  --pt-green:#7ee2b8; --pt-idle:#9aa0a6; --pt-bar-bg:var(--md-surface); }',

    /* 标题文字全部隐去，只留连接图标 + 三个圆点 */
    '.miot-main-appbar .miot-appbar-title { font-size:0 !important; }',
    '.miot-main-appbar .miot-appbar-subtitle { display:none !important; }',
    '.pt-status { display:inline-flex; align-items:center; gap:9px;',
    '  vertical-align:middle; font-size:0; line-height:1; }',
    '.pt-conn { display:inline-flex; align-items:center; justify-content:center;',
    '  width:22px; height:22px; flex:none; cursor:default; }',
    '.pt-conn img { width:22px; height:22px; display:block; object-fit:contain;',
    '  pointer-events:none; }',
    ':root[data-theme="dark"] .pt-conn img { filter:brightness(1.3); }',
    /* 定制图标的图形重心偏下（两根短竖条中心约在 70% 高度），圆点随之下移 */
    '.pt-dot-sm { position:relative; top:4px;',
    '  width:8px; height:8px; border-radius:50%; flex:none;',
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
    '.pt-theme-inline svg { width:22px; height:22px; display:block; }',

    /* 主题切换的轻提示（不是工具条控件） */
    '.pt-toast { position:fixed; left:50%; bottom:20px; transform:translate(-50%,12px);',
    '  z-index:300; max-width:min(92vw,620px); padding:11px 15px;',
    '  border-radius:14px; border:1px solid var(--md-outline-variant);',
    '  background:var(--md-surface-container-low, var(--md-surface));',
    '  color:var(--md-on-surface); box-shadow:0 8px 24px #0003;',
    '  font-size:13px; line-height:1.55; opacity:0; pointer-events:none;',
    '  transition:opacity .2s ease, transform .2s ease; }',
    '.pt-toast.show { opacity:1; transform:translate(-50%,0); pointer-events:auto; }',
    '@media (prefers-reduced-motion:reduce) { .pt-toast { transition:none; } }',

    /* AI 对话播报「未确认」是终态残留，不再常驻顶部 */
    '.chat-activity.pt-stale { display:none !important; }',

    /* 桌面：44px 圆形「继续播放」+ 240px 搜索框（原 120px 加倍），剩余宽度全给歌单框 */
    '@media (min-width:720px) {',
    '  .miot-page > .player-toolbar { flex-wrap:nowrap; row-gap:0;',
    '    min-height:44px !important; }',
    '  .miot-page > .player-toolbar > .toolbar-field {',
    '    flex:1 1 0 !important; min-width:170px; }',
    '  .miot-page > .player-toolbar > .toolbar-field .sl-select-trigger {',
    '    height:44px !important; min-height:44px !important; max-height:44px !important; }',
    '  .miot-page > .player-toolbar > .sl-button {',
    '    flex:0 0 44px !important; width:44px !important;',
    '    min-width:44px !important; max-width:44px !important;',
    '    height:44px !important; min-height:44px !important;',
    '    padding:0 !important; margin:0 !important;',
    '    border-radius:50% !important; overflow:hidden; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-button-label { display:none !important; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-icon { font-size:22px !important; }',
    '  .miot-page > .player-toolbar > .search-bar {',
    '    flex:0 0 240px !important; width:240px !important;',
    '    min-width:0 !important; max-width:240px !important;',
    '    margin-bottom:0 !important; height:44px;',
    '    padding:0 8px !important; gap:4px !important; }',
    '  .miot-page > .player-toolbar > .search-bar .sl-button-icon {',
    '    width:30px !important; height:30px !important; min-height:30px !important; }',
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
    '    position:relative; gap:8px !important; min-height:0 !important;',
    '    margin-bottom:8px !important; padding:0 !important;',
    '    border:0 !important; background:transparent !important; }',
    '  .miot-page > .player-toolbar > .toolbar-field {',
    '    flex:1 1 auto !important; width:auto !important; min-width:0 !important; }',
    /* 三个控件同高：歌单框与两个 44px 圆形按钮完全一致；
       展开搜索框用 inset:0 铺满工具行，高度自动跟着变成 44px */
    '  .miot-page > .player-toolbar > .toolbar-field .sl-select-trigger {',
    '    height:44px !important; min-height:44px !important; max-height:44px !important;',
    '    border-radius:999px !important; }',
    /* 「继续播放」→ 只留图标的圆形按钮 */
    '  .miot-page > .player-toolbar > .sl-button {',
    '    flex:0 0 44px !important; width:44px !important;',
    '    min-width:44px !important; max-width:44px !important;',
    '    height:44px !important; min-height:44px !important;',
    '    padding:0 !important; margin:0 !important;',
    '    border-radius:50% !important; overflow:hidden; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-button-label { display:none !important; }',
    '  .miot-page > .player-toolbar > .sl-button .sl-icon { font-size:22px !important; }',
    /* 搜索 → 44px 圆形按钮，默认折叠为放大镜 */
    '  .miot-page > .player-toolbar > .search-bar {',
    '    flex:0 0 44px !important; width:44px !important; height:44px !important;',
    '    min-width:0 !important; margin:0 !important; padding:0 !important;',
    '    border-radius:50% !important; justify-content:center;',
    '    overflow:hidden; cursor:pointer; }',
    '  .miot-page > .player-toolbar > .search-bar > :not(:first-child) {',
    '    display:none !important; }',
    '  .miot-page > .player-toolbar > .search-bar > :first-child {',
    '    font-size:22px !important; flex:none; }',
    /* iOS 在 input 字号 <16px 时聚焦会自动放大页面，锁死 16px */
    '  .miot-page .search-bar input { font-size:16px !important; }',
    /* 展开后铺满整行：不再偏上，也不会露出下层的歌单框底边 */
    '  .miot-page > .player-toolbar > .search-bar.pt-open {',
    '    position:absolute !important; top:0 !important; bottom:0 !important;',
    '    left:0 !important; right:0 !important; width:auto !important;',
    '    height:auto !important; min-height:0 !important; flex:none !important;',
    '    margin:0 !important; padding:0 12px !important;',
    '    border-radius:999px !important; align-items:center;',
    '    justify-content:flex-start; overflow:hidden; z-index:20; cursor:default;',
    '    background:var(--md-surface-container-lowest, var(--md-surface)) !important;',
    '    box-shadow:0 4px 16px #0002; }',
    '  .miot-page > .player-toolbar > .search-bar.pt-open > :not(:first-child) {',
    '    display:flex !important; }',
    '  .miot-page > .player-toolbar > .search-bar.pt-open > input {',
    '    display:block !important; flex:1 !important; min-width:0; }',
    /* 展开期间直接隐藏下层控件，杜绝任何透出 */
    '  .miot-page > .player-toolbar.pt-search-open > .toolbar-field,',
    '  .miot-page > .player-toolbar.pt-search-open > .sl-button {',
    '    visibility:hidden !important; }',
    '}',

    /* ===== 触屏按压反馈：去掉灰色遮罩，改为按下时图标变主题色 ===== */
    '@media (max-width:719px), (hover:none) {',
    /* iOS / WKWebView 点击时默认的半透明蓝灰高亮块 */
    '  button, .sl-button, .icon-button, .btn-icon, .search-bar, [role="button"] {',
    '    -webkit-tap-highlight-color:transparent !important; }',
    /* 触屏点按会残留 sticky :hover，M3 原规则由此留下一层灰色圆底 */
    '  .sl-button:hover:not(:disabled):not(.bar-play-primary):not(.control-primary),',
    '  .sl-button-text:hover:not(:disabled),',
    '  .player-bar .sl-button:hover:not(:disabled):not(.bar-play-primary):not(.control-primary),',
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
    /* 列表 20px 底部留白、播放条、播放条下方留白统一 #f8f8fc */
    '  .miot-page.miot-page-with-player {',
    '    padding-bottom:20px !important;',
    '    background-image:linear-gradient(to bottom, transparent calc(100% - 20px),',
    '      var(--pt-bar-bg) calc(100% - 20px)) !important; }',
    '  .player-bar-shell {',
    '    bottom:calc(20px + var(--sl-safe-bottom, 0px)) !important;',
    '    background:var(--pt-bar-bg) !important; }',
    '  .miot-page.miot-page-with-player::after { content:""; position:fixed;',
    '    left:0; right:0; bottom:0;',
    '    height:calc(20px + var(--sl-safe-bottom, 0px));',
    '    background:var(--pt-bar-bg); z-index:85; pointer-events:none; }',
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
    '    padding-bottom:calc(224px + var(--sl-safe-bottom, 0px)) !important; }',
    '}',

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
  var ICON_SUN = '<circle cx="12" cy="12" r="4"></circle>'
    + '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>';
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
  // 不设 title：图标不要悬停提示；img 不吃指针事件，避免任何 tooltip
  var connImg = document.createElement('img');
  connImg.src = CONN_PNG;
  connImg.alt = '';
  connImg.setAttribute('aria-hidden', 'true');
  connEl.appendChild(connImg);
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
    var r = bar.getBoundingClientRect();
    var small = window.innerWidth < 720;
    var w = small ? Math.max(240, window.innerWidth - 24) : 380;
    w = Math.min(w, window.innerWidth - 16);
    var left = small ? 12 : Math.min(r.left, window.innerWidth - w - 8);
    var top = Math.max(8, r.bottom + 6);
    var maxH = Math.max(160, window.innerHeight - top - (small ? 96 : 84));
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
        searchResults = (d && d.songs) || [];
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
    var online = d && d.online ? '（在线 ' + d.online + '）' : '';
    var head = '<div class="pt-search-head">飞牛音乐 · ' + n + ' 首'
      + online + ' · 点击即播</div>';
    if (!n) {
      panel.innerHTML = head + '<div class="pt-search-empty">没有匹配的歌曲</div>';
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
        return fetch(apiUrl('/mina/play-url'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: t.account, device_id: id, url: s.play_url }),
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
    hidePanel();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hidePanel();
  });
  window.addEventListener('resize', function () {
    if (!panel.classList.contains('show')) return;
    var bar = searchBarEl();
    if (bar) placePanel(bar);
  });
  window.addEventListener('scroll', function () {
    if (!panel.classList.contains('show')) return;
    var bar = searchBarEl();
    if (!bar || bar.getBoundingClientRect().bottom < 48) { hidePanel(); return; }
    placePanel(bar);
  }, true);


  /* ------------------------------------------------- 挂到面板应用栏（幂等） */
  var lastCtlW = 168;
  var lastWidthApplied = 0;
  var searchOpen = false;

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

  /* 手机端折叠的圆形搜索按钮：点一下展开成整行输入框，点外面收起 */
  function applySearchState(focus) {
    var s = document.querySelector('.miot-page .search-bar');
    var tb = s ? (s.closest ? s.closest('.player-toolbar') : s.parentNode) : null;
    if (s) s.classList.toggle('pt-open', searchOpen);
    if (tb) tb.classList.toggle('pt-search-open', searchOpen);
    if (searchOpen && focus) {
      var inp = s && s.querySelector('input');
      if (inp) setTimeout(function () { try { inp.focus(); } catch (e) { /* ignore */ } }, 0);
    }
  }
  function bindSearch(search) {
    if (search.getAttribute('data-pt-bound')) return;
    search.setAttribute('data-pt-bound', '1');
    search.addEventListener('click', function () {
      if (search.classList.contains('pt-open')) return;
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
    var s = document.querySelector('.miot-page .search-bar');
    if (s && (e.target === s || s.contains(e.target))) return;
    searchOpen = false;
    applySearchState(false);
  }, true);

  function handleChatActivity() {
    var el = document.querySelector('.chat-activity');
    if (!el) return;
    var stale = (el.textContent || '').indexOf('播报结束未确认') >= 0;
    el.classList.toggle('pt-stale', stale);
    if (stale) clearStaleChat();
  }

  function mount() {
    var appbar = document.querySelector('.miot-main-appbar');
    // 设置页 / 全屏播放页没有这条应用栏，什么都不显示
    if (appbar) {
      var subtitle = appbar.querySelector('.miot-appbar-subtitle');
      if (subtitle && (!statusEl.isConnected || statusEl.parentNode !== subtitle.parentNode)) {
        subtitle.parentNode.insertBefore(statusEl, subtitle.nextSibling);
      }
      var actions = appbar.querySelector('.appbar-actions');
      if (actions && (!themeEl.isConnected || themeEl.parentNode !== actions)) {
        // 追加为最后一个子元素 + CSS order:-1 => 排在「选择设备」之前，
        // 且不改变原生按钮的 nth-child 序号（小屏断点会隐藏第 2 个按钮）。
        actions.appendChild(themeEl);
      }
    }

    // 搜索栏原本是 .miot-page 的独立一行，搬到工具行末尾（幂等）。
    var toolbar = document.querySelector('.miot-page > .player-toolbar');
    var search = document.querySelector('.miot-page .search-bar');
    if (toolbar && search) {
      if (search.parentNode !== toolbar) toolbar.appendChild(search);
      syncSearchWidth(toolbar);
      clearPlaceholder(search);
      bindSearch(search);
      applySearchState(false);
    }
    // 「继续播放」圆钮移到歌单选择框之前。Vue 的 v-if 锚点会把它插回
    // .toolbar-field 之后，所以每次 mount 都幂等纠正一次；桌面 / 手机端
    // 统一为「继续播放 / 歌单选择器 / 搜索」。
    if (toolbar) {
      var resume = toolbar.querySelector(':scope > .sl-button');
      var field = toolbar.querySelector(':scope > .toolbar-field');
      if (resume && field && field.previousElementSibling !== resume) {
        toolbar.insertBefore(resume, field);
      }
    }
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
