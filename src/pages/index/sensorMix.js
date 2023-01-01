let main = (() => {
    // https://item.taobao.com/item.htm?id=674924558988

    function mixQuery() {
        return "01030002000265CB";
    } //多参数环境监测传感器查询指令

    function hexConverter(hex) {
        let str = parseInt("0x" + hex).toString();
        let num = Number(str);
        if (isNaN(num)) return 0;
        return Number(num);
    }
    //然后应该会回复16进制数据，如：
    function mixReader(hex) {
        let device_address = hex.substring(0, 2);
        let function_code = hex.substring(2, 4);
        let byte_read = hex.substring(4, 6);
        let temperature = Number((hexConverter(hex.substring(6, 10)) / 100 - 20).toFixed());
        let humidity = hexConverter(hex.substring(10, 14)) / 100;
        let pm_1 = hexConverter(hex.substring(30, 34));
        let pm_2_5 = hexConverter(hex.substring(34, 38));
        let pm_10 = hexConverter(hex.substring(38, 42));
        let co2 = hexConverter(hex.substring(78, 82));
        let o2 = hexConverter(hex.substring(82, 86)) / 100;
        let ch2o = hexConverter(hex.substring(90, 94)) / 100;
        let crc_byte_high = hex.substring(94, 96);
        let crc_byte_low = hex.substring(96, 98);
        let query_time = new Date().valueOf();
        let result = {
            device_address,
            function_code,
            byte_read,
            temperature,
            humidity,
            pm_1,
            pm_2_5,
            pm_10,
            co2,
            o2,
            ch2o,
            crc_byte_high,
            crc_byte_low,
            query_time,
        };
        // console.log(result);
        return result;
    } //多参数环境监测传感器数据解读
    return { mixQuery, mixReader };
})();

export default main;
