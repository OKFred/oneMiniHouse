let main = (() => {
  // https://item.taobao.com/item.htm?id=658222609252

  let deviceAddress = "21";
  let codeRead = "03";
  let generalLength = 18;

  function lightQuery() {
    let targetMemory = "0000";
    let byteRead = "0002";
    return deviceAddress + codeRead + targetMemory + byteRead;
    return "21030002000262AB"; //地址21，功能码03，起始地址0000，读取字节数0002，CRC校验码62AB
    
  } //光照传感器查询指令

  //然后应该会回复16进制数据，如：01 03 04 0000 05A7 B8D9
  function lightReader(hex) {
    let device_address = hex.substring(0, 2);
    let function_code = hex.substring(2, 4);
    let byte_read = hex.substring(4, 6);
    let lightness = hex.substring(6, 14).hexToDec() / 1000;
    let crc_byte_high = hex.substring(16, 18);
    let crc_byte_low = hex.substring(14, 16);
    let query_time = new Date().valueOf();
    let result = {
      device_address,
      function_code,
      byte_read,
      lightness,
      crc_byte_high,
      crc_byte_low,
      query_time,
    };
    // console.log(result);
    return result;
  } //光照传感器数据解读
  return {
    lightQuery,
    lightReader,
    deviceAddress,
    generalLength,
  };
})();

export default main;
