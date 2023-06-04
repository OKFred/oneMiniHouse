import process from "process";
import fs from "fs";

function weixinAutomation() {
    // read exec params when running this js
    let config = {
        env: process.env.NODE_ENV !== "development" ? "build" : "dev",
        platform: /mp-weixin/gi.test(process.env.npm_lifecycle_script) ? "mp-weixin" : "h5",
    };

    // copy the folder ./src/CICD/minitest and its subfolders/files to ./dist/${config.env}/mp-weixin/minitest
    if (config.platform === "mp-weixin") {
        let src = "./src/CICD/minitest";
        let dist = `./dist/${config.env}/mp-weixin/minitest`;
        if (!fs.existsSync(dist)) {
            fs.mkdirSync(dist, { recursive: true });
        }
        copyFolder(src, dist);
        console.log("已配置微信小程序自动化测试。打开【工具-自动化测试-回放】即可测试");
    }
}

function copyFolder(src, dist) {
    let paths = fs.readdirSync(src);
    paths.forEach(function (path) {
        var _src = src + "/" + path;
        var _dist = dist + "/" + path;
        fs.stat(_src, function (err, stats) {
            if (err) throw err;
            if (stats.isFile()) {
                let readable = fs.createReadStream(_src);
                let writable = fs.createWriteStream(_dist);
                readable.pipe(writable);
            } else if (stats.isDirectory()) {
                checkDirectory(_src, _dist, copyFolder);
            }
        });
    });
}

export { weixinAutomation };
