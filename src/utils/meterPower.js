let main = (() => {
  // https://detail.tmall.com/item.htm?id=686834692724
  //正泰DDSU-666
  //会回复16进制数据，
  //如： 5803204364CCCD000000000000000000000000000000003F800000000000004247EB85ACC2(基础数据)
  //基础(0,6) 电压(6,14) 电流(14-22) 有功(22-30) 无功(30-38) 视在(38-46) 功率因素(46-54) 电网频率(62,70)
  //5803043F9333339BEA (电能)

  function generalQuery() {
    return "580320000010430F";
  } // 读电压、电流、有功、无功、视在、功率因素、电网频率

  function energyQuery() {
    return "580340000002DD02";
  } // 读取电能

  function energyClearQuery() {
    return "581000020001020001F021";
  } //58 10 0002 0001 02 0001(未含cs) 电能清零

  function stopBitChangeQuery() {
    return "581000050001020005";
  } //581000050001020005 切换为1个停止位

  function hexConverter(hex) {
    if (hex == "00000000") return 0;
    let result = String("0x" + hex).hexToFloat();
    return result;
  }

  let deviceAddress = "58";
  let generalLength = 74;
  let energyLength = 18;

  function generalReader(hex) {
    let device_address = hex.substring(0, 2);
    let function_code = hex.substring(2, 4);
    let byte_read = hex.substring(4, 6);
    let voltage = hexConverter(hex.substring(6, 14));
    let current = hexConverter(hex.substring(14, 22));
    let active_power = hexConverter(hex.substring(22, 30));
    let reactive_power = hexConverter(hex.substring(30, 38));
    let apparent_power = hexConverter(hex.substring(38, 46));
    let power_factor = hexConverter(hex.substring(46, 54));
    let frequency = hexConverter(hex.substring(62, 70));
    let crc_byte_low = hex.substring(70, 72);
    let crc_byte_high = hex.substring(72, 74);
    let query_time = new Date().valueOf();
    let result = {
      device_address,
      function_code,
      byte_read,
      voltage,
      current,
      active_power,
      reactive_power,
      apparent_power,
      power_factor,
      frequency,
      crc_byte_high,
      crc_byte_low,
      query_time,
    };
    // console.log(result);
    return result;
  } //电表基础数据解读

  function energyReader(hex) {
    let device_address = hex.substring(0, 2);
    let function_code = hex.substring(2, 4);
    let byte_read = hex.substring(4, 6);
    let energy = hexConverter(hex.substring(6, 14));
    let crc_byte_low = hex.substring(14, 16);
    let crc_byte_high = hex.substring(16, 18);
    let query_time = new Date().valueOf();
    let result = {
      device_address,
      function_code,
      byte_read,
      energy,
      crc_byte_high,
      crc_byte_low,
      query_time,
    };
    // console.log(result);
    return result;
  } //电表电能数据解读
  return {
    generalReader,
    generalQuery,
    energyReader,
    energyQuery,
    energyClearQuery,
    stopBitChangeQuery,
    generalLength,
    energyLength,
    deviceAddress,
  };
})();

export default main;
