<template>
  <view class="ta-header my-center">
    <text>{{ localObj.name }}</text>
  </view>
  <view class="ta-content">
    <view class="my-center-vertically">
      <input
        type="text"
        placeholder="请输入服务器地址："
        :focus="true"
        :value="localObj.address"
        style="margin-bottom: 1rem"
      />
      <input
        type="text"
        placeholder="请输入端口号："
        :focus="true"
        :value="localObj.port"
        style="margin-bottom: 1rem"
      />
      <button
        size="mini"
        style="width: 30%"
        :type="localObj.connected ? 'primary' : 'warn'"
        :onTap="toggleConnect"
      >
        {{ localObj.connected ? "已连接" : "连接" }}
      </button>
    </view>
    <view class="my-center-vertically">
      <text style="padding-right: 1rem;">切换页面</text>
      <switch :checked="localObj.showPower" :onChange="togglePage" />
    </view>
    <view style="width: 100%; margin-top: 1rem; border-bottom: 0.1rem solid black;" />
    <view style="margin-top: 1rem" />
    <view style="margin-top: 1rem">查询时间：{{ localObj.queryTime }}</view>
    <view
      v-if="!localObj.showPower"
      class="my-far-table"
      style="margin-top: 2rem; margin-bottom: 1rem"
      v-for="(obj, index) in localObj.formHotWetArr"
      v-key="index"
    >
      <view>{{ obj.label }}</view>
      <view>{{ obj.value }}</view>
    </view>
    <view
      v-if="localObj.showPower"
      class="my-far-table"
      style="margin-bottom: 1rem"
      v-for="(obj, index) in localObj.formPowerArr"
      v-key="index"
    >
      <view>{{ obj.label }}</view>
      <view>{{ obj.value }}</view>
    </view>
  </view>
</template>

<script setup>
//模块引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  onUpdated,
} from "vue";
import "./index.css";
import Taro from "@tarojs/taro";
import { Buffer } from "buffer";

//自定义组件引入
import taskSensor from "./taskSensor.js";
import taskHotWet from "./taskHotWet.js";

//父系入参
const props = defineProps({
  globalObj: Object,
});

/* voltage: '电压(V)',
current: '电流(A)',
active_power: '有用功率(KW)',
reactive_power: '无用功率(Kvar)',
apparent_power: '视在功率(KVA)',
power_factor: '功率因数',
frequency: '频率(Hz)',
consumed_energy: '电能(KWh)', */

//本地变量和函数
let localObj = reactive({
  name: "智能家居",
  address: "172.28.0.4",
  port: "8899",
  formHotWetArr: [
    { label: "设备地址", value: "" },
    { label: "功能码", value: "" },
    { label: "读取字节数", value: "" },
    { label: "温度", value: "" },
    { label: "湿度", value: "" },
    { label: "CRC高位", value: "" },
    { label: "CRC低位", value: "" },
    // { label: "查询时间", value: "" },
  ],
  formPowerArr: [
    { label: "电压(V)", value: "230" },
    { label: "电流(A)", value: "230" },
    { label: "有用功率(KW)", value: "230" },
    { label: "无用功率(Kvar)", value: "230" },
    { label: "视在功率(KVA)", value: "230" },
    { label: "功率因数", value: "230" },
    { label: "频率(Hz)", value: "230" },
    { label: "电能(KWh)", value: "230" },
  ],
  connected: false,
  socket: null,
  showPower: false,
});
/*
watch(
    () => props.globalObj.msgs[localObj.name],
    (newValue, oldValue) => {
        if (newValue) distribute(newValue)
    },
    { immediate: true },
) //处理来自App.vue的消息分发 */

function setTitle() {
  const title = "小程序";
  Taro.setNavigationBarTitle({ title });
}

function togglePage() {
  localObj.showPower = !localObj.showPower;
  console.log("切换页面", localObj.showPower);
}

let intervalTask;
function toggleConnect() {
  let { address, port } = localObj;
  console.log("目标服务器", address, port);
  if (localObj.connected) {
    clearInterval(intervalTask);
    localObj.connected = false;
    console.log("已断开");
  } else {
    onTCPConnect({ address, port });
  }
} //连接服务器

let authTasks = (socket) => {
  // console.log("进行认证");
  // socket.write("hello there!");
  console.log("开启轮询");
  intervalTask = setInterval(() => {
    if (localObj.connected) {
      onTCPMessage(socket, "010400010002200b"); //发送问询数据
    }
  }, 1000);
};

let farewellTasks = (socket) => {
  console.log("再见了咯");
  socket.write("see you later!");
};

/*
function dataReader(data) {
  let { socket }=localObj;
  let enc = new TextDecoder("utf-8");
  let finalData = enc.decode(data);
  console.log(finalData, finalData.length, socket);
  if (finalData === "approved!") {
    console.log("开启轮询");
    intervalTask = setInterval(() => {
      if (localObj.connected) {
        onTCPMessage(socket, "580320000010430F");
      }
    }, 1000);
  } else if (finalData === "denied!") {
    socket.close();
    socket = null;
  }
  if (finalData.length === 20) {
    localObj.queryTime = new Date(finalData).toLocaleString();
  }
  if (!localObj.connected) {
    socket.close();
    socket = null;
  }
  // else
  return;
} */

function onTCPMessage(socket, hex) {
  let hexArr = [];
  for (let i = 0; i < hex.length; i = i + 2) {
    hexArr.push("0x" + hex.substring(i, i + 2));
  }
  // console.log(hexArr);
  let buffer = Buffer.from(hexArr); //将数组放到buffer
  // console.log(buffer);
  socket.write(buffer);
} //发送数据

async function onTCPConnect({ address, port }) {
  console.log("进行tcp连接");
  let socket = localObj.socket ? localObj.socket : Taro.createTCPSocket();
  socket.connect({ address, port });
  localObj.socket = socket;
  socket.onConnect((e) => {
    console.log(new Date().toLocaleTimeString() + "已连接");
    localObj.connected = true;
    authTasks(socket); //握手
  });

  socket.onClose((e) => {
    console.log(new Date().toLocaleTimeString() + "已断开");
    localObj.connected = false;
    farewellTasks(socket); //挥手
  });

  socket.onMessage((e) => {
    console.log("收到数据", e);
    let { message, remoteInfo, localInfo, size } = e;
    /* if (size===9)  */return dataReader(buf2hex(message)); //体验版似乎计算不了长度，暂时作罢
    let finalData = wx.decode({ data: message, format: 'utf8' }); //不要用new TextDecoder，因为手机端不兼容T_T
    console.log(finalData)
    if (finalData === `Port already in use\r\n`) {
      globalThis.queryResult(false, "端口已被占用，请等待他人释放");
      return;
    }
  }); //接收数据
}

//然后应该会回复16进制数据，如：010404012000E0FA3A
function dataReader(hex) {
  let device_address = hex.substring(0, 2);
  if (device_address === "01") {
    let {
      device_address,
      function_code,
      byte_read,
      tempature,
      humidity,
      crc_byte_high,
      crc_byte_low,
      query_time,
    } = taskHotWet.tempHumidSensorReader(hex) || {};
    localObj.formHotWetArr.find((obj) => obj.label === "设备地址").value = device_address;
    localObj.formHotWetArr.find((obj) => obj.label === "功能码").value = function_code;
    localObj.formHotWetArr.find((obj) => obj.label === "读取字节数").value = byte_read;
    localObj.formHotWetArr.find((obj) => obj.label === "温度").value = tempature;
    localObj.formHotWetArr.find((obj) => obj.label === "湿度").value = humidity;
    localObj.formHotWetArr.find((obj) => obj.label === "CRC高位").value = crc_byte_high;
    localObj.formHotWetArr.find((obj) => obj.label === "CRC低位").value = crc_byte_low;
    localObj.queryTime = new Date(query_time).toLocaleString();
    // localObj.formHotWetArr.find((obj) => obj.label === "查询时间").value = query_time;
    return;
  }
  // 根据设备地址做对应的数据解读；
}

function buf2hex(buffer) { // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
}

onUpdated(() => {
  // console.log("login: onUpdated");
});
onMounted(() => {
  console.log("login: onMounted");
  setTitle();
  //queryConfig() //查询配置
});
onActivated(() => {
  console.log("login: onActivated");
}); //已登录的话清除下登录信息
</script>
