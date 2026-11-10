// fnmusic-miot 薄壳插件入口（运行于飞牛音乐 QuickJS 插件宿主内）
//
// 本插件只为「在飞牛音乐 app 内嵌一个音箱控制页」而存在，自身不实现任何
// 音箱控制逻辑。真正的控制在同机运行的 fnmusic-miot 原生应用里：
//   - 控制层 API : http://127.0.0.1:8775
//   - nodeconsole 面板 : http://127.0.0.1:8776
// WebView 入口页 static/index.html 以全屏 iframe 加载该原生面板。
//
// 宿主契约（见 @songloft/plugin-sdk）：把生命周期/请求处理函数挂到 globalThis。
// 这里仅满足契约，不做后端工作。

globalThis.onInit = async function onInit() {
  songloft.log.info('[fnmusic-miot] 薄壳插件初始化');
};

globalThis.onDeinit = async function onDeinit() {
  songloft.log.info('[fnmusic-miot] 薄壳插件停止');
};

globalThis.onQueryBusy = async function onQueryBusy() {
  // 薄壳插件不持有播放状态，始终按空闲返回。返回必须是 JSON 字符串：
  // 宿主用字符串化方式读取返回值，直接返回对象会变成 Go map 文本导致解析失败。
  return JSON.stringify({ busy: false, reason: '' });
};

globalThis.onHTTPRequest = async function onHTTPRequest(req) {
  // 本插件不提供后端路由；返回 404 让宿主明确知晓。
  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: 'fnmusic-miot shell plugin exposes no backend; open the WebView page.',
    }),
  };
};

globalThis.onWebSocket = async function onWebSocket(req, socket) {
  if (socket && typeof socket.close === 'function') {
    await socket.close(1008, 'no websocket endpoint');
  }
};
