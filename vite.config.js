import { defineConfig, loadEnv } from "vite";
import uni from "@dcloudio/vite-plugin-uni";
import path from "node:path";
import fs from "node:fs";
import { pageFinder, uniPageMaker } from "./src/page.config.js";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    fs.writeFileSync("./src/pages.json", `${JSON.stringify(uniPageMaker(pageFinder()), null, 4)}\n`);
    return {
        plugins: [uni(), {
            name: "wechat-build-assets",
            closeBundle() {
                if (process.env.UNI_PLATFORM !== "mp-weixin") return;
                // Use the locked H5 dependency in the native canvas too, without
                // keeping a second, potentially stale library in the source tree.
                const nativeRoot = path.resolve(process.env.UNI_OUTPUT_DIR, "wxcomponents/ec-canvas");
                fs.mkdirSync(nativeRoot, { recursive: true });
                for (const [source, target] of [
                    ["dist/echarts.min.js", "echarts.js"], ["LICENSE", "LICENSE.echarts"], ["NOTICE", "NOTICE.echarts"],
                ]) {
                    fs.copyFileSync(path.resolve("node_modules/echarts", source), path.join(nativeRoot, target));
                }
                if (!env.UNI_MP_APPID) return;
                const configPath = path.resolve(process.env.UNI_OUTPUT_DIR, "project.config.json");
                const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
                config.appid = env.UNI_MP_APPID;
                fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
            },
        }],
        resolve: { alias: { "@": path.resolve("src") } },
        optimizeDeps: { include: ["dayjs"] },
        base: env.VITE_BASE_PATH || "/",
        server: { host: "127.0.0.1" },
    };
});
