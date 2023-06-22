<template>
  <!-- 表单 -->
  <view style="background-color: white; padding: 1vh 2vw; margin: 1vh 2vw;">
    <myForm :parentObj="localObj.forms[0]" />
  </view>
  <view style="margin-top: 1vh" />
  <view style="background-color: white; padding: 1vh 2vw; margin: 1vh 2vw;">
    <myForm :parentObj="localObj.forms[1]" />
  </view>
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入
import myForm from "/src/components/my-form/index.vue"; //引入组件
import modbus from "/src/base/modbus.js";
import bg from "/src/utils/bg.js";
import tcpLink from "/src/utils/tcpLink.js";
import meterPower from "/src/utils/meterPower.js";

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

onMounted(() => {
  console.log("自动查询");
  tcpInit();//初始化TCP参数
  tcpLink.toggleConnect() //建立连接
  taskStart() //轮询任务
});
onBeforeUnmount(() => {
  console.log('结束轮询')
  tcpPause();
})

const props = defineProps({
  globalObj: Object,
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数

setData({
  addressUpdate,
  intervalTask: null,
  currentBuffer: "",
  buffers: {
    '电能表单': '',
    '参数表单': '',
  },
  formCollection: {
    '电能表单': [],
    '参数表单': [],
  },
  forms: [
    {
      onEdit,
      onEditComplete,
      parent: "电能表单",
      formArr: [
        { label: "查询时间", value: "" },
        { label: "设备地址", value: "" },
        { label: "电能", value: "", postfix: "千瓦时(度)", postfixColor: 'grey' },
      ],
    },
    {
      onEdit,
      onEditComplete,
      parent: "参数表单",
      formArr: [
        { label: "电压", value: "", postfix: "伏", postfixColor: 'grey' },
        { label: "电流", value: "", postfix: "安", postfixColor: 'grey' },
        { label: "有用功率", value: "", postfix: "瓦", postfixColor: 'grey' },
        { label: "无用功率", value: "", postfix: "乏", postfixColor: 'grey' },
        { label: "视在功率", value: "", postfix: "伏安", postfixColor: 'grey' },
        { label: "频率", value: "", postfix: "赫兹", postfixColor: 'grey' },
        { label: "功率因数", value: "" },
      ],
    },
  ],
});

function tcpInit() {
  let bgObj = bg.read();
  if (!bgObj.address) bgObj.address = globalThis.app.globalData.address;
  if (!bgObj.port) bgObj.port = globalThis.app.globalData.port;
  tcpLink.setData({
    ...bgObj,
    // query: detailQueryHex,
    dataReader, //设置对应的数据读取器
    saver
  });
}//初始化TCP

function saver() {
  globalThis.queryResult(false, "连接超时，请检查网络")
  tcpPause()
}

function tcpPause() {
  clearInterval(props.localObj.intervalTask)
  tcpLink.setData({
    address: '',
    port: '',
    // query: null,
    dataReader: null
  });
} //暂停TCP

function addressUpdate(newAddress) {
  if (!newAddress) return;
  clearInterval(props.localObj.intervalTask);
  //clear buffer
  props.localObj.currentBuffer = "";
  props.localObj.buffers = {
    '电能表单': '',
    '参数表单': '',
  };
  //clear form
  props.localObj.formCollection = {
    '电能表单': [],
    '参数表单': [],
  };
  //clear form value
  props.localObj.forms.forEach((form) => {
    form.formArr.forEach((item) => {
      item.value = "";
    });
  });
  meterPower.addressWriteQuery(newAddress);
  taskStart();
}

function taskStart() {
  console.log("开启轮询");
  globalThis.queryResult(true, "连接中，请稍后...");
  props.localObj.intervalTask = setInterval(() => {
    const energyQueryHex = (() => {
      let hex = meterPower.energyQuery();
      hex += modbus.crc(hex);
      return hex;
    })();
    const detailQueryHex = (() => {
      let hex = meterPower.detailQuery();
      hex += modbus.crc(hex);
      return hex;
    })();
    let status = tcpLink.sendMessage(detailQueryHex); //发送问询数据
    if (!status) clearInterval(props.localObj.intervalTask);
    setTimeout(() => tcpLink.sendMessage(energyQueryHex), 1000);
    // console.log("同时查询电能");
  }, 2000);
}; //轮询任务

function dataReader(hex) {
  // console.log(hex)
  if (/Port already in use/gi.test(hex.hexToASCII())) {
    console.log('端口已被占用')
    return globalThis.queryResult(false, '端口已被占用')
  };//ser2net 返回的错误信息
  let device_address = hex.substring(0, 2);
  let byte_read = hex.substring(4, 6);
  let bufferReset = () => {
    props.localObj.buffers[props.localObj.currentBuffer] = '';
    props.localObj.currentBuffer = "";
    // console.log('缓存已清空')
  }
  let bufferAdd = (str) => {
    props.localObj.buffers[props.localObj.currentBuffer] += str;
    let hexNew = props.localObj.buffers[props.localObj.currentBuffer]
    // console.log('缓存已更新')
    return hexNew;
  }
  let crcCheck = (hex) => {
    if (hex.length < 4) return console.log('数据长度不足4位，无法校验');
    let dataPart = hex.substring(0, hex.length - 4);
    let crcPart = hex.substring(hex.length - 4, hex.length);
    if (modbus.crc(dataPart).toUpperCase() !== crcPart.toUpperCase()) {
      console.log("数据校验失败");
      return false
    } //CRC校验
    return true;
  }
  if (![meterPower.deviceAddress].find(str => str === device_address) && !['20', '04'].find(str => str === byte_read)) {
    // console.log('设备地址/指令不匹配，看看是否有缓存需要合并');
    if (props.localObj.currentBuffer) {
      hex = bufferAdd(hex);
      device_address = hex.substring(0, 2);
      byte_read = hex.substring(4, 6);
      // console.log('⚠️②可能是分段数据，先放缓存', byte_read)
    } //如果有缓存，先合并缓存
    if (hex.length > 1024) {
      // console.log('缓存数据过长，清空缓存');
      return bufferReset();
    }
  }
  if (byte_read === "04") {
    let formName = "电能表单";
    if (hex.length < meterPower.energyLength) {
      props.localObj.currentBuffer = formName;
      return bufferAdd(hex);
    } else if (hex.length > meterPower.energyLength) hex = hex.substring(0, meterPower.energyLength); //长度校验；
    bufferReset();
    if (!crcCheck) return
    return setForm(formName, hex);
  } else if (byte_read === "20") {
    let formName = "参数表单";
    if (hex.length < meterPower.detailLength) { //[本应该到74，TCP buffer 长度限制在了64]
      props.localObj.currentBuffer = formName;
      // console.log('🚩①长度不足，先放缓存')
      return bufferAdd(hex);
    } else if (hex.length > meterPower.detailLength) hex = hex.substring(0, meterPower.detailLength); //长度校验；
    bufferReset();
    if (!crcCheck) return
    return setForm(formName, hex);
  } else console.log("有例外的？", hex, hex.length);
}  // 根据设备地址做对应的数据&返回的字节数去解读；

function setForm(formName, hex) {
  let { formArr } = props.localObj.forms.find(obj => obj.parent === formName);
  let dataSaver = (obj) => {
    props.localObj.formCollection[formName].unshift(obj);
    if (props.localObj.formCollection[formName].length > 100) {
      props.localObj.formCollection[formName].pop()
    }
  } //暂存数据，用于投喂图表
  if (formName === '电能表单' && hex.length === meterPower.energyLength) {
    // console.log('✅pass')
    let energyObj = meterPower.energyReader(hex);
    dataSaver(energyObj)
    let { device_address, energy, query_time } = energyObj;
    formArr.find((obj) => obj.label === "查询时间").value = new Date(query_time).Format('yyyy-MM-dd hh:mm:ss');
    formArr.find((obj) => obj.label === "设备地址").value = device_address;
    formArr.find((obj) => obj.label === "电能").value = energy?.toFixed(2);
    /*  formArr.find((obj) => obj.label === "功能码").value = function_code;
    formArr.find((obj) => obj.label === "读取字节数").value = byte_read;
    formArr.find((obj) => obj.label === "CRC高位").value = crc_byte_high;
    formArr.find((obj) => obj.label === "CRC低位").value = crc_byte_low; */
  } else if (formName === '参数表单' && hex.length === meterPower.detailLength) {
    // console.log('✅pass')
    let detailObj = meterPower.detailReader(hex);
    dataSaver(detailObj);
    let {
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
    } = detailObj;
    /* formArr.find((obj) => obj.label === "查询时间").value = new Date(query_time).Format('yyyy-MM-dd hh:mm:ss');
    formArr.find((obj) => obj.label === "设备地址").value = device_address;
      formArr.find((obj) => obj.label === "功能码").value = function_code;
    formArr.find((obj) => obj.label === "读取字节数").value = byte_read; */
    formArr.find((obj) => obj.label === "电压").value = voltage?.toFixed(2);
    formArr.find((obj) => obj.label === "电流").value = current?.toFixed(2);
    formArr.find((obj) => obj.label === "有用功率").value = (1000 * active_power)?.toFixed(2);
    formArr.find((obj) => obj.label === "无用功率").value = (1000 * reactive_power)?.toFixed(2);
    formArr.find((obj) => obj.label === "视在功率").value = (1000 * apparent_power)?.toFixed(2);
    formArr.find((obj) => obj.label === "功率因数").value = power_factor?.toFixed(2);
    formArr.find((obj) => obj.label === "频率").value = frequency?.toFixed(2);
    /* formArr.find((obj) => obj.label === "CRC高位").value = crc_byte_high;
    formArr.find((obj) => obj.label === "CRC低位").value = crc_byte_low; */
  }
}

function onEdit(params) {
  let { obj, index, parent } = params;
  let formObj = props.localObj.forms.find((obj) => obj.parent === parent);
  let { formArr } = formObj;
  // console.log("开始填写表单", obj, index);
  let { type, option } = obj; //表单类型
}

async function onEditComplete(params) {
  let { obj, index, value, name, parent } = params;
  let formObj = props.localObj.forms.find((obj) => obj.parent === parent);
  let { formArr } = formObj;
  // console.log("表单已更新", JSON.parse(JSON.stringify(formArr))); 
}
</script>

<style></style>
