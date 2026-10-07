// 公共依赖
import "/src/base/proto_date";
import "/src/base/proto_string";
import "/src/base/proto_number";
import "/src/base/proto_array";

// 环境依赖
// #ifdef MP-WEIXIN
import * as network from "/src/base/wx_network.js";
console.log("引入小程序依赖");
// #endif

// #ifdef H5
import * as network from "/src/base/network.js";
import * as uni from "@dcloudio/uni-h5/dist/uni-h5.es.js";
console.log("引入网页依赖");
// #endif

// 业务依赖
// import logger from "/src/utils/logger.js";
import rpc from "/src/fetch/rpc";
import router from "/src/router/index";
import myApp from "./app.data.js";

console.log("全局数据引入", myApp);

// Credentials are entered at runtime; development builds do not embed local login files.

(function checkPlatform() {
    return process.env.VUE_APP_PLATFORM === "mp-weixin"
        ? (() => {
              console.log("小程序");
          })()
        : (() => {
              console.log("💻HTML");
          })(); //⚠️能用的接口不一样
})();

function loadUserData() {
    let userInfoObj = uni?.getStorageSync?.("userInfoObj");
    if (!userInfoObj) return console.log("未登录");
    if (!globalThis.app.globalData) return;
    globalThis.app.globalData.userInfoObj = userInfoObj;
    // console.log("用户信息已加载"); //登录了就写到全局数据里
}
setTimeout(loadUserData, 0);

//全局数据和方法
Object.assign(myApp, {
    onNav({ pageName, navType, timeout, paramObj } = {}) {
        let { url } = router.find((obj) => obj.name === pageName) || {};
        console.log(`🚩当前页`, pageName);
        if (!url) {
            console.log(pageName);
            return globalThis.queryResult(false, "找不到对应的页面");
        }
        uni.setNavigationBarTitle({
            title: globalThis.app.globalData?.appPublicName,
        }); //设置导航栏标题
        if (paramObj && typeof paramObj === "object") {
            url += "?" + globalThis.objToParam(paramObj);
        }
        if (!navType) navType = "navigateTo";
        let navFn = () => {
            try {
                uni[navType]({
                    url,
                    animationType: "fade-in", //动画效果 //uniapp h5专属
                    success: (e) => () => {},
                    // globalThis.logger.writeLog({
                    //     fileName: "router",
                    //     data: { pageName, navType },
                    // }), //日志记录路由历史
                    fail: (e) => {
                        console.log(e, "请检查是否在app.json中定义了该页面");
                        globalThis.queryResult(false, "页面路径有误");
                    },
                }); //返回失败则跳转登录页
            } catch (e) {
                console.log(`页面不支持跳转`, e.message);
                uni.reLaunch(router.find((obj) => obj.name === "登录"));
            }
        };
        if (timeout && typeof timeout === "number") setTimeout(navFn, timeout);
        else navFn();
    }, //根据 router 内的路由去跳转，可选跳转类型和传参
    onNavBack({ timeout, paramObj } = {}) {
        if (paramObj && typeof paramObj === "object") {
            let pageArr = getCurrentPages();
            let previousPage = pageArr[pageArr.length - 2];
            if (!previousPage) return console.log("找不到上一页");
            previousPage.options = paramObj;
        } //给子页面传参
        let navFn = () =>
            uni.navigateBack({
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
                uni.reLaunch({
                    url: router.find((obj) => obj.name === "首页").url,
                });
            },
        });
    },
});

globalThis.router = router;
globalThis.objToParam = network.objToParam;
globalThis.paramToObj = network.paramToObj;
globalThis.sleep = network.sleep;

globalThis.prepareMsg = function prepareMsg(What) {
    let queryObj = rpc.find((obj) => (obj.info.index || obj.info.for) === What);
    if (!queryObj) return console.log("⚠️找不到对应的接口", What);
    queryObj = JSON.parse(JSON.stringify(queryObj)); //深拷贝
    /^http/.test(queryObj.request.url)
        ? ""
        : (queryObj.request.url = globalThis.app.globalData.server + queryObj.request.url);
    let userInfoObj = globalThis.app.globalData.userInfoObj || uni?.getStorageSync?.("userInfoObj");
    let { token } = userInfoObj || {};
    if (token !== undefined) {
        queryObj.request.header.headers = queryObj.request.header.headers || {};
        queryObj.request.header.headers["Authorization"] = token;
    }
    return queryObj;
};
globalThis.doFetch = async (...args) => {
    let queryObj = await network.doFetch(...args);
    if (!queryObj.response.data || queryObj.response.data.code !== 200) {
        globalThis.onLog({
            debugType: process.env.NODE_ENV,
            apiName: queryObj.info.index,
            info: queryObj,
        });
    }
    return queryObj;
};

/**
 * @param {object} obj 参数对象
 * @param {string} obj.debugType 环境类型
 * @param {string} obj.apiName API名称
 * @param {object} obj.info 详情
 * @description 日志保存
 * */
globalThis.onLog = function ({ debugType, apiName, info } = {}) {
    let pages = getCurrentPages(); // 获取栈实例
    if (!pages || !pages.length) return;
    let currentRoute = pages[pages.length - 1]; // 获取当前页面路由
    let path = currentRoute.$page.fullPath; // 获取当前页面路径
    let enterOptions = uni.getEnterOptionsSync();
    let { scene } = enterOptions;
    let debugAPI = debugType === "development" ? "保存前端日志" : "Web日志 - 新增";
    let debugObj = globalThis.prepareMsg(debugAPI);
    if (!debugObj) return;
    debugObj.request.data = {
        appName: globalThis.app.globalData.appName, //小程序名称
        name: String(scene), //名称
        time: new Date().Format("yyyy-MM-dd hh:mm:ss"), //时间
        pagePath: path, //页面路径
        level: "warning", //报错等级
        // apiName: queryObj.info.index, //API名称
        // info: queryObj, //详情
        annex: "none", //附件
        apiName, //API名称
        info, //详情
    };
    network.doFetch(debugObj);
};

// 界面交互
globalThis.queryResult = function queryResult(status, info) {
    uni.showToast({
        duration: status ? 2000 : 4000,
        icon: status ? "success" : "error",
        title: info,
    });
    return;
};
globalThis.showModal = function showModal({
    content,
    title = "对话框",
    callback = console.log,
    confirmButtonText = "确定",
    cancelButtonText = "取消",
}) {
    return uni.showModal({
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
};

// #ifdef MP-WEIXIN
//版本更新
let updateManager = uni?.getUpdateManager?.();
updateManager?.onCheckForUpdate((res) => {
    console.log("有新版本？", res.hasUpdate);
});
updateManager?.onUpdateReady(() => {
    globalThis.showModal({
        title: "更新提示",
        content: "新版本已经准备好，是否重启应用？",
        complete: (status) => {
            if (status) updateManager.applyUpdate();
        },
    });
});
updateManager?.onUpdateFailed(() => {
    globalThis.queryResult(false, "更新失败");
});

// #endif

export default myApp;
