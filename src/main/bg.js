//框架引入
import Taro from "@tarojs/taro";

let main = (() => {
  function check() {
    let obj = Taro.getStorageInfoSync();
    let { currentSize, keys, limitSize } = obj;
    if (currentSize > limitSize) console.log("存储空间不足");
    return obj;
  }

  function read(key) {
    let obj = {};
    if (key === undefined) {
      let { keys } = check();
      keys.forEach((k) => {
        obj[k] = Taro.getStorageSync(k);
      });
    } else obj[key] = Taro.getStorageSync(key);
    return obj;
  }

  function write(key, value) {
    Taro.setStorageSync(key, value);
    return read(key);
  }

  function remove(key) {
    Taro.removeStorageSync(key);
  }

  function clear() {
    Taro.clearStorageSync();
  }

  return {
    read,
    write,
    remove,
    clear,
  };
})();

export default main;
