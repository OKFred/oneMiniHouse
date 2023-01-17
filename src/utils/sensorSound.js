let main = (() => {
  // https://item.taobao.com/item.htm?id=564783797581
  // 噪音传感器查询指令
  let deviceAddress = "0E";
  let codeRead = "03";
  let codeWrite = "06";
  let generalLength = 14;

  function addressWriteQuery() {
    let targetMemory = "07D0";
    let dataWrite = "0007";
    return "FF" + codeWrite + targetMemory + dataWrite;
  } //FF0607D0000E; 修改设备地址

  function volumeQuery() {
    let targetMemory = "0000";
    let byteRead = "0001";
    return deviceAddress + codeRead + targetMemory + byteRead;
  } //01 03 0000 0001 840A

  //然后应该会回复16进制数据，如：01 03 02 019d 787d
  function volumeReader(hex) {
    let device_address = hex.substring(0, 2);
    let function_code = hex.substring(2, 4);
    // 0x03:读保持寄存器
    // 0x04: 读输入寄存器
    // 0x06:写单个保持寄存器
    // 0x10:写多个保持寄存器
    let byte_read = hex.substring(4, 6);
    let volume = hex.substring(6, 10).hexToDec() / 10;
    let crc_byte_high = hex.substring(10, 12);
    let crc_byte_low = hex.substring(12, 14);
    let query_time = new Date().valueOf();
    let result = {
      device_address,
      function_code,
      byte_read,
      volume,
      crc_byte_high,
      crc_byte_low,
      query_time,
      hex,
    };
    // console.log(result);
    return result;
  }
  return {
    volumeQuery,
    volumeReader,
    addressWriteQuery,
    deviceAddress,
    generalLength,
  };
})();

export default main;
