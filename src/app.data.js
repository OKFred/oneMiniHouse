export default {
  globalData: {
    appName: "冷库信息化-记账",
    appPublicName: "农企服",
    server: (() => {
      return process.env.NODE_ENV === "development"
        ? "https://本地开发环境.com"
        : "https://生产环境.com"; //⚠️送审
    })(),
  },
};
