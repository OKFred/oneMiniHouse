let appData = {
    globalData: {
        appName: "oneMiniHouse",
        appPublicName: "oneHouse",
        address: "tcp.fred.wiki",
        port: 8899,
        NODE_ENV: process.env.NODE_ENV,
        VUE_APP_PLATFORM: process.env.VUE_APP_PLATFORM,
        环境: process.env.NODE_ENV === "development" ? "开发环境" : "生产环境",
        平台: "小程序",
        server: (() =>
            process.env.NODE_ENV === "development" ? "http://kaifa" : "https://shengchan")(), //送审⚠️
    },
};

let ua = globalThis?.navigator?.userAgent;
if (ua && /MicroMessenger/gi.test(ua)) {
    appData.globalData["平台"] = "嵌入网页";
    console.log("当前为小程序内置浏览器");
}
export default appData;
