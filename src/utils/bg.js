//框架引入

let main = (() => {
  function check() {
    let obj = uni.getStorageInfoSync();
    let { currentSize, keys, limitSize } = obj;
    if (currentSize > limitSize) console.log("存储空间不足");
    return obj;
  }

  function read(key) {
    let obj = {};
    if (key === undefined) {
      let { keys } = check();
      keys.forEach((k) => {
        obj[k] = uni.getStorageSync(k);
      });
    } else obj[key] = uni.getStorageSync(key);
    return obj;
  }

  function write(key, value) {
    uni.setStorageSync(key, value);
    return read(key);
  }

  function remove(key) {
    uni.removeStorageSync(key);
  }

  function clear() {
    uni.clearStorageSync();
  }

  return {
    read,
    write,
    remove,
    clear,
  };
})();

export default main;
