import bg from "/src/utils/bg.js"; //框架引入
import { runtimeConfig } from "/src/config/runtime.js";

async function serverSaveQuery({ address, port } = {}) {
    if (!address || !port) {
        return { status: false, result: "不能为空" };
    }
    for (let [k, v] of Object.entries({ address, port })) {
        bg.write(k, v);
    }
    return { status: true, result: "保存成功" };
}

async function serverQuery() {
    let obj = bg.read();
    let result = { address: obj.address || runtimeConfig.tcpHost, port: obj.port || String(runtimeConfig.tcpPort) };
    return { status: true, result };
}

export { serverSaveQuery, serverQuery };
