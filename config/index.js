const path = require("path");
const fs = require("fs");

function traversalRead(currentDirPath, callback) {
  fs.readdirSync(currentDirPath, { withFileTypes: true }).forEach(
    (directory) => {
      var filePath = path.join(currentDirPath, directory.name);
      if (directory.isFile()) {
        callback(filePath, directory);
      } else if (directory.isDirectory()) {
        traversalRead(filePath, callback);
      }
    }
  );
}

/* let allComponents = [];
(function getAllComponents() {
  let dir = "src/components";
  traversalRead(dir, function (filePath, stat) {
    let sep = path.sep;
    let to = `dist/` + filePath.replace("src" + sep, "");
    allComponents.push({
      from: filePath,
      to,
    });
  });
})(); */

const config = {
  alias: {
    "@/src": path.resolve(__dirname, "..", "src"),
    "@vant/weapp": path.resolve(__dirname, "../src/components/vant-weapp"),
  }, //用于支持绝对路径
  copy: {
    patterns: [],
    options: {},
  },
  projectName: "oneMiniHouse",
  date: "2022-12-30",
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
  },
  sourceRoot: "src",
  outputRoot: "dist",
  plugins: [],
  defineConstants: {},
  framework: "vue3",
  compiler: "webpack5",
  cache: {
    enable: false, // Webpack 持久化缓存配置，建议开启。默认配置请参考：https://docs.taro.zone/docs/config-detail#cache
  },
  mini: {
    miniCssExtractPluginOption: {
      ignoreOrder: true,
    }, //忽略css文件引入顺序
    optimizeMainPackage: {
      enable: false,
    }, //对分包问题有效果
    postcss: {
      pxtransform: {
        enable: true,
        config: {
          selectorBlackList: [/van-/],
        }, // 过滤 vant 组件库的前缀：van-
      },
      url: {
        enable: true,
        config: {
          limit: 1024, // 设定转换尺寸上限
        },
      },
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        config: {
          namingPattern: "module", // 转换模式，取值为 global/module
          generateScopedName: "[name]__[local]___[hash:base64:5]",
        },
      },
    },
  },
  h5: {
    publicPath: "/",
    staticDirectory: "static",
    postcss: {
      autoprefixer: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        config: {
          namingPattern: "module", // 转换模式，取值为 global/module
          generateScopedName: "[name]__[local]___[hash:base64:5]",
        },
      },
    },
  },
  rn: {
    appName: "taroDemo",
    postcss: {
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
      },
    },
  },
};

module.exports = function (merge) {
  if (process.env.NODE_ENV === "development") {
    return merge({}, config, require("./dev"));
  }
  return merge({}, config, require("./prod"));
};
