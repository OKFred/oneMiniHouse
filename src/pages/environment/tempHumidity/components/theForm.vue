<template>
  <!-- 表单 -->
  <view class="white-container">
    <myCardsListd :parentObj="localObj.forms[0]" />
  </view>
  <view style="margin-top: 1rem" />
</template>

<script setup>
//框架引入
import Taro from "@tarojs/taro";
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
import myCardsListd from "@/src/components/mycards-listd/index.vue"; //引入组件
import modbus from "@/src/base/modbus.js";
import bg from "@/src/main/bg.js";
import tcpLink from "@/src/utils/tcpLink.js";
import sensorHotWet from "@/src/utils/sensorHotWet.js";

const hotWetQueryHex = sensorHotWet.hotWetQuery();

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

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
  intervalTask: null,
  currentBuffer: "",
  buffers: {
    '主表单': '',
  },
  formCollection: {
    '主表单': [],
  },
  forms: [
    {
      onEdit,
      onEditComplete,
      parent: "主表单",
      formArr: [
        { label: "查询时间", value: "" },
        { label: "设备地址", value: "" },
        // { label: "功能码", value: "" },
        // { label: "读取字节数", value: "" },
        { label: "温度", value: "", postfix: '℃', postfixColor: 'grey' },
        { label: "湿度", value: "", postfix: '%', postfixColor: 'grey' },
        // { label: "CRC高位", value: "" },
        // { label: "CRC低位", value: "" },
      ],
    },
  ],
});

function tcpInit() {
  tcpLink.setData({
    ...bg.read(),
    query: hotWetQueryHex,
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
    query: null,
    dataReader: null
  });
} //暂停TCP

function taskStart() {
  console.log("开启轮询");
  globalThis.queryResult(true, "连接中，请稍后...");
  props.localObj.intervalTask = setInterval(() => {
    let status = tcpLink.sendMessage(hotWetQueryHex); //发送问询数据
    if (!status) clearInterval(props.localObj.intervalTask);
  }, 2000);
}; //轮询任务

function dataReader(hex) {
  // console.log(hex)
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
  if (![sensorHotWet.deviceAddress].find(str => str === device_address) && !['04'].find(str => str === byte_read)) {
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
    let formName = "主表单";
    if (hex.length < sensorHotWet.hotWetLength) {
      props.localObj.currentBuffer = formName;
      // console.log('🚩①长度不足，先放缓存')
      return bufferAdd(hex);
    } else if (hex.length > sensorHotWet.hotWetLength) hex = hex.substring(0, sensorHotWet.hotWetLength); //长度校验；
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
  if (formName === '主表单' && hex.length === sensorHotWet.hotWetLength) {
    // console.log('✅pass')
    let generalObj = sensorHotWet.hotWetReader(hex);
    dataSaver(generalObj);
    let {
      device_address,
      function_code,
      byte_read,
      temperature,
      humidity,
      crc_byte_high,
      crc_byte_low,
      query_time,
    } = generalObj;
    formArr.find((obj) => obj.label === "查询时间").value = new Date(query_time).toLocaleString();
    formArr.find((obj) => obj.label === "设备地址").value = device_address;
    formArr.find((obj) => obj.label === "温度").value = temperature;
    formArr.find((obj) => obj.label === "湿度").value = humidity;
  }
}

function onEdit(params) {
  let { obj, index, parent } = params;
  let { formArr } = props.localObj.forms.find((obj) => obj.parent === parent);
  console.log("开始填写表单", obj, index);
  let { type, option } = obj;
  if (type === undefined) {
    return console.log("只读");
  } else if (type === "plateNumber") {
    try {
      Taro.chooseLicensePlate({
        success: (e) => {
          console.log(e);
          formArr[index].value = e.plateNumber;
        }, fail: (e) => {
          console.log("用户取消输入", e);
          formArr[index].value = "";
        },
      }); //微信自带车牌号输入模块，根据后端反馈修改 20221029
    } catch (e) {
      globalThis.queryResult(false, "请更新微信版本");
    }
  } else if (type === "text" || type === "number" || type === "digit") {
    formArr[index].editing = true;
  } else if (type === "plateNo") {
    props.localObj.showPlate = true;
  } else if (type === "select") {
    let showOptions = true;
    let optionArr = props.localObj.options[option];
    if (!optionArr || optionArr.length === 0) {
      optionArr = [];
      globalThis.queryResult(false, "选项缺失");
    }
    let optionTarget = { index, parent }; //方便选择之后定位所属的表单项目
    setData({ showOptions, optionArr, optionTarget, needCalc });
  } else if (type === "selectArea") {
    let showArea = true;
    let optionTarget = { index, parent }; //方便选择之后定位所属的表单项目
    setData({ showArea, optionTarget });
  }
}
function onEditComplete(params) {
  let { obj, index, value, parent } = params;
  let { formArr } = props.localObj.forms.find((obj) => obj.parent === parent);
  formArr[index].value = value;
  formArr[index].editing = false;
  console.log("表单已更新", JSON.parse(JSON.stringify(formArr)));
  // props.localObj.fetchData();
}
</script>

<style>

</style>
