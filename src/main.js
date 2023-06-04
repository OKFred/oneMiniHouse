import { createSSRApp } from "vue";
import uView from "uview-plus";

import App from "./App.vue";
import myApp from "./app.js"; //定义一些全局函数和数据
import "./app.css"; //定义一些全局样式
// 引入uView对小程序分享的mixin封装
import myShare from "./app.config.js";

export function createApp() {
  let app = createSSRApp(App);
  // app.use(uView);
  app.mixin(myShare);
  globalThis.app = Object.assign(app, myApp);
  return {
    app,
  };
}
