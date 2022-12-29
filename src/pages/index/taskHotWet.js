// 读取温湿度传感器数据  //https://item.taobao.com/item.htm?id=582340027559
// 20221229
// FredZ

var main = (() => {
  function tempHumidSensorReader(hex) {
    let device_address = hex.substring(0, 2);
    let function_code = hex.substring(2, 4);
    // 0x03:读保持寄存器
    // 0x04: 读输入寄存器
    // 0x06:写单个保持寄存器
    // 0x10:写多个保持寄存器
    let byte_read = hex.substring(4, 6);
    let tempature = hexToDec(hex.substring(6, 10)) / 10;
    let humidity = hexToDec(hex.substring(10, 14)) / 10;
    let crc_byte_high = hex.substring(14, 16);
    let crc_byte_low = hex.substring(16, 18);
    let query_time = new Date().valueOf();
    let result = {
      device_address,
      function_code,
      byte_read,
      tempature,
      humidity,
      crc_byte_high,
      crc_byte_low,
      query_time,
    };
    // console.log(result);
    return result;
  }

  return {
    tempHumidSensorReader,
  };
})();

function hexToDec(hex) {
  let str = parseInt("0x" + hex).toString();
  let num = Number(str);
  if (isNaN(num)) return 0;
  return num;
} //16进制 → 10进制

export default main;
