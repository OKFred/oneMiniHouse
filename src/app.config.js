// 该文件为uni-app的全局配置文件，用于配置整个应用
import myApp from "./app.data.js";

let _shareObj = {
    title: myApp.globalData.appPublicName, //自定义标题
    path: `/pages/index/index`, //默认跳转首页
    imageUrl: "", //可设置默认分享图，不设置默认截取头部5:4
    success: (success) => {
        globalThis.queryResult(true, "分享成功");
        console.log("返回结果", success);
    },
    fail: (fail) => {
        globalThis.queryResult(false, "分享失败");
        console.log("返回结果", fail);
    },
};

export default {
    onShareAppMessage(res) {
        let pages = getCurrentPages(); //动态获取当前页面栈
        let thisPage = pages[pages.length - 1]; //当前页页面实例
        let shareObj = { ..._shareObj, path: thisPage.route, ...(thisPage.data.shareObj || {}) };
        return shareObj;
    }, //发送给朋友
    onShareTimeline(res) {
        let pages = getCurrentPages(); //动态获取当前页面栈
        let thisPage = pages[pages.length - 1]; //当前页页面实例
        let shareObj = { ..._shareObj, path: thisPage.route, ...(thisPage.data.shareObj || {}) };
        return shareObj;
    }, //分享到朋友圈
};
