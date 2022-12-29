import { createApp } from "vue";
import "./app.css"; // app.js

import "./base/proto_date";
import "./base/proto_string";
import "./base/proto_number";
import "./base/proto_array";
import network from "./base/network";
import Taro from "@tarojs/taro";

import rpc from "./fetch/rpc";

let myApp;
const rpcDataStr = JSON.stringify(rpc);
globalThis.doFetch = network.doFetch;
globalThis.objToParam = network.objToParam;
globalThis.paramToObj = network.paramToObj;
globalThis.sleep = network.sleep;
// globalThis.router = router;
// globalThis.logger = logger;
globalThis.showModal = showModal;
globalThis.queryResult = queryResult;
globalThis.prepareMsg = prepareMsg;
function prepareMsg(What) {
  let rpcData = JSON.parse(rpcDataStr);
  let queryObj = rpcData.find((obj) => obj.info.for === What);
  queryObj.request.url = myApp.globalData.baseUrl + queryObj.request.url;
  return queryObj;
}

// 界面交互
function queryResult(status, info) {
  return Taro.showToast({
    duration: status ? 2000 : 4000,
    icon: status ? "success" : "error",
    title: info,
  });
}
function showModal({
  content,
  title = "对话框",
  callback,
  type = "confirm",
  confirmButtonText = "确定",
  cancelButtonText = "取消",
}) {
  return Taro.showModal({
    title,
    content,
    cancelText: cancelButtonText,
    confirmText: confirmButtonText,
    success: function (res) {
      if (res.confirm) {
        return true;
      } else if (res.cancel) {
        return false;
      }
    },
    complete: callback(res),
  });
}

const App = createApp({
  onShow(options) {},
  // 入口组件不需要实现 render 方法，即使实现了也会被 taro 所覆盖
});

export default App;
