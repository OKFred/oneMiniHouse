"use strict";
import router from "./router/index"; //自定义路由

function pageFinder() {
  let pages = router
    .filter((obj) => !obj.root)
    .map((obj) => obj.url.replace(/^\//, "")); //主包页面
  let subpackages = [];
  for (let obj of router) {
    if (!obj.root || subpackages.find((str) => str === obj.root)) continue;
    subpackages.push(obj.root);
  } //先拿到分包的数量
  let subpagesFinder = (rootReg) =>
    router
      .filter((obj) => {
        let condition = rootReg.test(obj.url);
        if (condition) obj.url = obj.url.replace(rootReg, "");
        return condition;
      })
      .map((obj) => obj.url);
  subpackages = subpackages.map((root) => {
    let roots = root.split("/");
    let rootReg = new RegExp(`\^\/${roots.join(`\/`)}\/`, "gi");
    let pages = subpagesFinder(rootReg);
    return {
      root,
      pages,
    };
  });
  return {
    pages,
    subpackages,
  };
} //在路由表里找到所有匹配的页面

export default {
  ...pageFinder(),
  /*   pages: ["pages/index/index", "pages/mine/index"],
  subpackages: [
    {
      root: "pages/spend", //支出
      pages: pageFinder(/^\/pages\/spend\//gi),
    },
    {
      root: "pages/expense",
      pages: pageFinder(/^\/pages\/income\//gi),
    },
  ], */
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#fff",
    // navigationBarTitleText: "WeChat",
    navigationBarTextStyle: "black",
    navigationStyle: "custom",
  },
  usingComponents: {
    "van-icon": "@vant/weapp/icon/index",
    "van-field": "@vant/weapp/field/index",
    "van-cell": "@vant/weapp/cell/index",
    "van-cell-group": "@vant/weapp/cell-group/index",
    "van-swipe-cell": "@vant/weapp/swipe-cell/index",
    "van-popup": "@vant/weapp/popup/index",
    "van-action-sheet": "@vant/weapp/action-sheet/index",
    "van-dialog": "@vant/weapp/dialog/index",
  },
  tabBar: {
    custom: true,
    list: [
      {
        pagePath: "pages/index/index",
        text: "首页",
      },
      {
        pagePath: "pages/mine/index",
        text: "我的",
      },
    ],
  },
};
