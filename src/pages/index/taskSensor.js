"use strict";
let main = (() => {
    function hexToFloat(hex) {
        let float = 0; //小数
        let sign; //正负
        let mantissa; //有效位
        let exp; //指数
        let dec = 0; //十进制
        let multi = 1;
        let result; //返回值
        if (/^0x/.exec(hex)) {
            dec = parseInt(hex, 16);
        } else {
            for (let i = hex.length - 1; i >= 0; i -= 1) {
                if (hex.charCodeAt(i) > 255) return console.log("Wrong string");
                dec += hex.charCodeAt(i) * multi;
                multi *= 256;
            }
        }
        sign = dec >>> 31 ? -1 : 1;
        exp = ((dec >>> 23) & 0xff) - 127;
        mantissa = ((dec & 0x7fffff) + 0x800000).toString(2);
        for (let i = 0; i < mantissa.length; i += 1) {
            float += parseInt(mantissa[i]) ? Math.pow(2, exp) : 0;
            exp--;
        }
        result = float * sign;
        return result;
    } //十六进制转换为小数

    function read_temperature(hex) {
        let subHex = hex.substring(6, 10);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        num = Number((num / 100 - 20).toFixed(2));
        return num;
    } //温度
    function read_humidity(hex) {
        let subHex = hex.substring(10, 14);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        num = num / 100;
        return num;
    } //湿度
    function read_PM1(hex) {
        let subHex = hex.substring(30, 34);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        return num;
    } //PM1.0
    function read_PM25(hex) {
        let subHex = hex.substring(34, 38);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        return num;
    } //PM2.5
    function read_PM10(hex) {
        let subHex = hex.substring(38, 42);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        return num;
    } //PM10
    function read_CO2(hex) {
        let subHex = hex.substring(78, 82);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        return num;
    } //二氧化碳
    function read_O2(hex) {
        let subHex = hex.substring(82, 86);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str) / 100;
        if (isNaN(num)) return 0;
        return num;
    } //氧气
    function read_CH2O(hex) {
        let subHex = hex.substring(90, 94);
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str) / 100;
        if (isNaN(num)) return 0;
        return num;
    } //甲醛

    function read_light(hex) {
        let subHex = hex.substring(6, 14); //不能用前导0声明8进制直接量
        let str = parseInt("0x" + subHex).toString();
        let num = Number(str) / 1000;
        if (isNaN(num)) return 0;
        return num;
    } //光照

    //正泰DDSU-666
    //基础(0,6) 电压(6,14) 电流(14-22) 有功(22-30) 无功(30-38) 视在(38-46) 功率因素(46-54) 电网频率(62,70)
    function read_voltage(hex) {
        let subHex = hex.substring(6, 14);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //电压(U)(V)(6,14)

    function read_current(hex) {
        let subHex = hex.substring(14, 22);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } // 电流(I)(A)(14-22)

    function read_activePower(hex) {
      let subHex = hex.substring(22, 30);
      if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //有功(P)(KW)(22-30)

    function read_reactivePower(hex) {
        let subHex = hex.substring(30, 38);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //无功(Q)(Kvar)(30-38)

    function read_apparentPower(hex) {
        let subHex = hex.substring(38, 46);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //视在(S)(KVA)(38-46)

    function read_powerFactor(hex) {
        let subHex = hex.substring(46, 54);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //功率因数(Ft)(float)(46,54)

    function read_frequency(hex) {
        let subHex = hex.substring(62, 70);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //电网频率(Frequency)(Hz)(62,70)

    function read_consumedEnergy(hex) {
        let subHex = hex.substring(6, 14);
        if (subHex == '00000000') return 0;
        let result = hexToFloat("0x" + subHex);
        return result;
    } //电能(energy)(KWh)(6,14)

    return {
        read_temperature,
        read_humidity,
        read_PM1,
        read_PM25,
        read_PM10,
        read_O2,
        read_CO2,
        read_CH2O,
        read_light,
        read_voltage,
        read_current,
        read_activePower,
        read_reactivePower,
        read_apparentPower,
        read_powerFactor,
        read_frequency,
        read_consumedEnergy,
    };
})();

export default main;
