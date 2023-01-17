let main = (() => {
  // https://item.taobao.com/item.htm?id=582340027559
  // 温湿度传感器查询指令
  let deviceAddress = "0F";
  let codeRead = "04";
  let codeWrite = "06";
  let generalLength = 18;

  function hotWetQuery() {
    let targetMemory = "0001";
    let byteRead = "0002";
    return deviceAddress + codeRead + targetMemory + byteRead;
  } //010400010002200B

  function addressWhiteQuery() {
    let targetMemory = "0101";
    let dataWrite = "0007";
    return deviceAddress + codeWrite + targetMemory + dataWrite;
  } //0F0601010007 、修改地址为07

  //然后应该会回复16进制数据，如：010404012000E0FA3A
  function hotWetReader(hex) {
    let device_address = hex.substring(0, 2);
    let function_code = hex.substring(2, 4);
    // 0x03:读保持寄存器
    // 0x04: 读输入寄存器
    // 0x06:写单个保持寄存器
    // 0x10:写多个保持寄存器
    let byte_read = hex.substring(4, 6);
    let temperature = hex.substring(6, 10).hexToDec() / 10;
    let humidity = hex.substring(10, 14).hexToDec() / 10;
    let crc_byte_high = hex.substring(14, 16);
    let crc_byte_low = hex.substring(16, 18);
    let query_time = new Date().valueOf();
    let result = {
      device_address,
      function_code,
      byte_read,
      temperature,
      humidity,
      crc_byte_high,
      crc_byte_low,
      query_time,
      hex,
    };
    // console.log(result);
    return result;
  }
  return {
    hotWetQuery,
    hotWetReader,
    addressWhiteQuery,
    deviceAddress,
    generalLength,
  };
})();

export default main;
