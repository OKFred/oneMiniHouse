export default {
  globalData: {
    appName: "oneMiniHouse",
    appPublicName: "oneHouse",
    address: "tcp.fred.wiki",
    port: 8899,
    server: (() => {
      return process.env.NODE_ENV === "development"
        ? "https://本地开发环境.com"
        : "https://生产环境.com"; //⚠️送审
    })(),
  },
};
