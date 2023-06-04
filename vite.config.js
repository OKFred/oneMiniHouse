import { defineConfig } from "vite";
import uni from "@dcloudio/vite-plugin-uni";

import { viteExternalsPlugin } from "vite-plugin-externals";
import path from "path";
import fs from "fs";
import { pageFinder, uniPageMaker } from "./src/page.config.js";
import { weixinAutomation } from "./src/CICD/index.js";

let pageObj = pageFinder();
if (!pageObj || typeof pageObj !== "object") throw new Error("未找到页面");
let pageConfig = uniPageMaker(pageObj);
let text = JSON.stringify(pageConfig, null, 4);
fs.writeFileSync("./src/pages.json", text, "utf-8");

//配置微信小程序自动化测试
setTimeout(weixinAutomation, 20 * 1000);

function resolve(dir) {
    return path.join(__dirname, dir);
}

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        uni(),
        viteExternalsPlugin({
            "node-fetch": "node-fetch",
        }),
    ],
    resolve: {
        alias: { "@": resolve("src") },
    },
    base: "/one-minihouse/",
    build: {
        rollupOptions: {
            // 确保外部化处理那些你不想打包进库的依赖
            external: ["node-fetch"],
            output: {
                // 在 UMD 构建模式下为这些外部化的依赖提供一个全局变量
                globals: {
                    "node-fetch": "node-fetch",
                },
            },
        },
    },
});
