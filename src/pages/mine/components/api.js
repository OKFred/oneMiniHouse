//框架引入
import bg from "@/src/main/bg.js";

let main = (() => {
  async function serverSaveQuery({ address, port } = {}) {
    if (!address || !port) {
      return { status: false, result: "不能为空" };
    }
    for (let [k, v] of Object.entries({ address, port })) {
      bg.write(k, v);
    }
    return { status: true, result: "保存成功" };
  }
  return {
    serverSaveQuery,
  };
})();
export default main;
