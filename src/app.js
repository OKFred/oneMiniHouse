import { createApp } from "vue";
import Taro from "@tarojs/taro";

import "./app.css";
import "./base/proto_date";
import "./base/proto_string";
import "./base/proto_number";
import "./base/proto_array";
import network from "./base/taro_network";

import logger from "./utils/logger";
import router from "./router/index";
import rpc from "./fetch/rpc";
import myApp from "./app.data.js";
console.log("全局数据引入", myApp);

let app;
setTimeout(() => (app = Object.assign(getApp(), myApp)), 0); //全局app对象；

//全局数据和方法
globalThis.app = Object.assign(myApp, {
  onNav({ pageName, navType, timeout, paramObj } = {}) {
    let { url } = router.find((obj) => obj.name === pageName) || {};
    if (!url) {
      console.log(pageName);
      return globalThis.queryResult(false, "找不到对应的页面");
    }
    if (paramObj && typeof paramObj === "object") {
      url += "?" + globalThis.objToParam(paramObj);
    }
    if (!navType) navType = "navigateTo";
    let navFn = () =>
      Taro[navType]({
        url,
        success: (e) =>
          globalThis.logger.writeLog({
            fileName: "router",
            data: { pageName, navType },
          }), //日志记录路由历史
        fail: (e) => {
          console.log(e, "请检查是否在app.json中定义了该页面");
          globalThis.queryResult(false, "页面路径有误");
        },
      }); //返回失败则跳转登录页
    if (timeout && typeof timeout === "number") setTimeout(navFn, timeout);
    else navFn();
  }, //根据 router 内的路由去跳转，可选跳转类型和传参
  onNavBack({ timeout, paramObj } = {}) {
    if (paramObj && typeof paramObj === "object") {
      let pageArr = getCurrentPages();
      let previousPage = pageArr[pageArr.length - 2];
      previousPage.setData(paramObj);
    } //给子页面传参
    let navFn = () =>
      Taro.navigateBack({
        // success: (e) =>
        //     console.log(globalThis.logger.readLog({
        //         fileName: "router",
        //         date: new Date().Format("yyyy-MM-dd"),
        //     })), //测试日志输出功能
        fail: (e) => {
          console.log(e);
          return myApp.onNav({ pageName: "首页", navType: "switchTab" });
        }, //需要兼顾匿名用户访问某个页面的需求
      });
    if (timeout && typeof timeout === "number") setTimeout(navFn, timeout);
    else navFn();
  },
  onRestart() {
    globalThis.showModal({
      title: "提示",
      content: "小程序重开后生效。现在重开？",
      callback: (status) => {
        if (!status) return console.log("取消重开");
        Taro.reLaunch({
          url: router.find((obj) => obj.name === "首页").url,
        });
      },
    });
  },
}); //全局变量
const rpcDataStr = JSON.stringify(rpc);

globalThis.objToParam = network.objToParam;
globalThis.paramToObj = network.paramToObj;
globalThis.sleep = network.sleep;
globalThis.router = router;
globalThis.logger = logger;
globalThis.showModal = showModal;
globalThis.queryResult = queryResult;
globalThis.prepareMsg = prepareMsg;

function prepareMsg(What, debug) {
  let rpcData = JSON.parse(rpcDataStr);
  let queryObj = rpcData.find((obj) => obj.info.for === What);
  if (debug) return queryObj;
  // queryObj.request.url = myApp.globalData.server + queryObj.request.url;
  let { userInfoObj } = myApp.globalData;
  let { token } = userInfoObj || {};
  if (token !== undefined) {
    if (queryObj.request.header.headers && queryObj.request.header.headers) {
      queryObj.request.header.headers.Authorization = token;
    } else {
      queryObj.request.header.headers = { Authorization: token };
    } //加个token，如果已经登录了的话
  }
  return queryObj;
}
globalThis.doFetch = async (...args) => {
  let queryObj = await network.doFetch(...args);
  if (!queryObj.response.data || !queryObj.response.data.success) {
    let debugObj = prepareMsg("保存前端日志", "debug");
    let { scene, path } = Taro.getLaunchOptionsSync();
    debugObj.request.data = {
      appName: globalThis.app.globalData.appName, //小程序名称
      name: scene, //名称
      time: new Date().Format("yyyy-MM-dd hh:mm:ss"), //时间
      pagePath: path, //页面路径
      level: "warning", //报错等级
      info: queryObj, //详情
      annex: "", //附件
    };
    network.doFetch(debugObj);
  }
  return queryObj;
};

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
        return callback(true);
      } else if (res.cancel) {
        return callback(false);
      }
    },
    fail: function (res) {
      return callback(false);
    },
  });
}

//版本更新
const updateManager = Taro.getUpdateManager();
updateManager.onCheckForUpdate((res) => {
  console.log("有新版本？", res.hasUpdate);
});
updateManager.onUpdateReady(() => {
  globalThis.showModal({
    title: "更新提示",
    content: "新版本已经准备好，是否重启应用？",
    complete: (status) => {
      if (status) updateManager.applyUpdate();
    },
  });
});
updateManager.onUpdateFailed(() => {
  globalThis.queryResult(false, "更新失败");
});

const App = createApp({
  onShow(options) {},
});

export default App;
