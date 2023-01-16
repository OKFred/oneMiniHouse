import { Buffer } from "buffer";

let main = (() => {
  /**
   *  MODBUS-RTU CRC校验
   * @param data Buffer对象十六进制Hex
   * @returns {any[]}  十六进制高低位
   * @constructor
   */

  function crc(hex) {
    let data = Buffer.from(hex, "hex");
    let crcValue = 0xffff;
    for (let i = 0; i < data.length; i++) {
      crcValue ^= data[i] & 0xffff;
      for (let j = 0; j < 8; j++) {
        if (crcValue & 0x0001) {
          crcValue >>= 1;
          crcValue ^= 0xa001;
        } else {
          crcValue >>= 1;
        }
      }
    }

    crcValue = crcValue.toString(16);
    let crcArr = new Array(2);
    crcArr[0] = crcValue.substring(2, 4);
    crcArr[1] = crcValue.substring(0, 2);
    return crcArr.join("");
  }

  /**
*  测试
function testmodbus_crc() {
  console.log(crc("010400F40002"))   //输出 3039
}*/

  return {
    crc,
  };
})();

export default main;
