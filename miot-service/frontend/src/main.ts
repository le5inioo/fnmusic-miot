import { createApp } from 'vue';
import App from './App.vue';
import { installListCoverVisibilityRecovery } from './covers';
import './style.css';
import './styles/redesign.css';

// fnOS 独立部署没有 Songloft 宿主注入的 window.SongloftPlugin。
// api.ts / runtime.ts / covers.ts 的 browser fallback 全部走可选链，缺宿主时
// 自动改用 fetch；面板鉴权由 webui-service 同源反代注入 Authorization，
// 前端不需要（也不应该）持有 token。故意不注入 stub，让 fallback 真正生效。

installListCoverVisibilityRecovery();

createApp(App).mount('#app');
