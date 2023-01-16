<template>
  <myheaderd pageName="智能家居" />
  <mycontents>
    <slot-view :name="'myContentSlot'" style="margin-top: 5rem; margin-bottom: 5rem">
      <view class="my-center-vertically" style="margin-bottom: 1.5rem">
        <input type="text" placeholder="请输入服务器地址：" :value="localObj.address"
          @blur="(e) => onDataChange({ key: 'address', value: e.detail.value })" />
        <input type="text" placeholder="请输入端口号：" :value="localObj.port" />
        <button size="default" style="width: 35%" :type="localObj.connected ? 'primary' : 'warn'"
          :onTap="toggleConnect">
          {{ localObj.connected ? "已连接" : "连接" }}
        </button>
      </view>
      <picker mode="selector" :range="localObj.tabArr" @change="onTabChange" class="my-center-vertically">
        <view style="
            border: 0.1rem solid orangered;
            border-radius: 1rem;
            padding: 1rem 0;
            width: 90vw;
          " class="my-far-table">
          <text style="padding: 0 1rem">当前选择：</text>
          <text style="padding: 0 1rem">
            {{ localObj.tabArr[localObj.currentTab] }}
          </text>
        </view>
      </picker>
      <view style="margin-top: 1rem" />
      <view style="margin-top: 1rem" class="my-far-table"><text>查询时间：</text><text>{{ localObj.queryTime }}</text></view>
      <view style="margin-top: 1rem; border-bottom: 0.1rem dashed royalblue" />
      <view v-if="localObj.tabArr[localObj.currentTab] === '光亮'" class="my-far-table my-font"
        style="margin-top: 2rem; margin-bottom: 1rem; font-size: 1.2rem" v-for="(obj, index) in localObj.formLightArr"
        v-key="index">
        <view style="font-weight: bold">{{ obj.label }}</view>
        <view style="color: grey">{{ obj.value }}</view>
      </view>
      <view v-if="localObj.tabArr[localObj.currentTab] === '温湿度'" class="my-far-table my-font"
        style="margin-top: 2rem; margin-bottom: 1rem; font-size: 1.2rem" v-for="(obj, index) in localObj.formHotWetArr"
        v-key="index">
        <view style="font-weight: bold">{{ obj.label }}</view>
        <view style="color: grey">{{ obj.value }}</view>
      </view>
      <view v-if="localObj.tabArr[localObj.currentTab] === '电表'" class="my-far-table my-font"
        style="margin-top: 2rem; margin-bottom: 1rem; font-size: 1.2rem" v-for="(obj, index) in localObj.formPowerArr"
        v-key="index">
        <view style="font-weight: bold">{{ obj.label }}</view>
        <view style="color: grey">{{ obj.value }}</view>
      </view>
      <view v-if="localObj.tabArr[localObj.currentTab] === '环境'" class="my-far-table my-font"
        style="margin-top: 2rem; margin-bottom: 1rem; font-size: 1.2rem" v-for="(obj, index) in localObj.formMixArr"
        v-key="index">
        <view style="font-weight: bold">{{ obj.label }}</view>
        <view style="color: grey">{{ obj.value }}</view>
      </view>
      <view style="margin-top: 1rem" />
      <mybuttond :text="'返 回'" color="blue-plain" style="width: 40vw" @tap="onBtnClick"
        :data-date="new Date().toLocaleString()" />
    </slot-view>
  </mycontents>
  <!-- <image :src="headerBlack" /> -->
</template>

<script setup>
//模块引入
import Taro from "@tarojs/taro";
import {
  reactive,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";
import { Buffer } from "buffer";

//自定义组件引入
import sensorHotWet from "./sensorHotWet.js";
import sensorLight from "./sensorLight.js";
import sensorMix from "./sensorMix.js";
import meterPower from "../electricity/logics/meterPower.js";
// import headerBlack from "../../assets/header-black.png";

//父系入参
const props = defineProps({
  globalObj: Object,
});
definePageConfig({
  navigationBarTitleText: "首页",
  navigationStyle: "custom",
  usingComponents: {
    "van-button": "@vant/weapp/button/index",
    "myheaderd": "@/src/components/myheaderd/index",
    "mycontents": "@/src/components/mycontents/index",
    "mybuttond": "@/src/components/mybuttond/index"
  },
});
const hotWetQueryHex = sensorHotWet.hotWetQuery();
const mixQueryHex = sensorMix.mixQuery();
const lightQueryHex = sensorLight.lightQuery();
const generalQueryHex = meterPower.generalQuery();
const energyQueryHex = meterPower.energyQuery();

//本地变量和函数
let localObj = reactive({
  pageName: "智能家居",
  headerColor: "blue",
  address: "tcp.fred.wiki",
  port: "8899",
  formLightArr: [
    { label: "设备地址", value: "" },
    { label: "功能码", value: "" },
    { label: "读取字节数", value: "" },
    { label: "亮度", value: "" },
    { label: "CRC高位", value: "" },
    { label: "CRC低位", value: "" },
    // { label: "查询时间", value: "" },
  ],
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
    { label: "设备地址", value: "" },
    { label: "电压(V)", value: "", postfix: "V" },
    { label: "电流(A)", value: "", postfix: "A" },
    { label: "有用功率(KW)", value: "", postfix: "KW" },
    { label: "无用功率(Kvar)", value: "", postfix: "Kvar" },
    { label: "视在功率(KVA)", value: "", postfix: "KVA" },
    { label: "功率因数", value: "" },
    { label: "频率(Hz)", value: "", postfix: "Hz" },
    { label: "电能(KWh)", value: "", postfix: "KWh" },
  ],
  formMixArr: [
    { label: "设备地址", value: "" },
    { label: "功能码", value: "" },
    { label: "读取字节数", value: "" },
    { label: "温度", value: "" },
    { label: "湿度", value: "" },
    { label: "PM 1", value: "" },
    { label: "PM 2.5", value: "" },
    { label: "PM 10", value: "" },
    { label: "二氧化碳", value: "" },
    { label: "氧气", value: "" },
    { label: "甲醛", value: "" },
    { label: "CRC高位", value: "" },
    { label: "CRC低位", value: "" },
    // { label: "查询时间", value: "" },
  ],
  connected: false,
  socket: null,
  showPower: false,
  tabArr: ["请选择", "光亮", "温湿度", "电表", "环境"],
  currentTab: "0",
  queryArr: ["", lightQueryHex, hotWetQueryHex, generalQueryHex, mixQueryHex],
  currentQuery: "",
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

function onTabChange(e) {
  let { value } = e.detail;
  localObj.currentTab = value;
  localObj.currentQuery = localObj.queryArr[value];
  console.log("切换页面");
}

function onDataChange({ key, value } = {}) {
  localObj[key] = value;
  console.log("数据已更新");
}

function onBtnClick(e) {
  console.log(e);
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
    if (!localObj.currentQuery) {
      return globalThis.queryResult(false, "请先选择");
    }
    onTCPConnect({ address, port });
  }
} //连接服务器

let authTasks = (socket) => {
  // console.log("进行认证");
  // socket.write("hello there!");
  console.log("开启轮询");
  intervalTask = setInterval(() => {
    if (localObj.connected) {
      onTCPMessage(socket, localObj.currentQuery); //发送问询数据
      if (localObj.currentQuery === generalQueryHex) {
        // console.log("同时查询电能");
        setTimeout(() => onTCPMessage(socket, energyQueryHex), 1000);
      }
    }
  }, 2000);
};

let farewellTasks = (socket) => {
  console.log("再见了咯");
  socket.write("see you later!");
};

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
    /* if (size===9)  */ return dataReader(buf2hex(message)); //体验版似乎计算不了长度，暂时作罢
    let decoder = new TextDecoder();
    console.log(decoder.decode(message));
    let finalData = wx.decode({ data: message, format: "utf8" }); //不要用new TextDecoder，因为手机端不兼容T_T
    console.log(finalData);
    if (finalData === `Port already in use\r\n`) {
      globalThis.queryResult(false, "端口已被占用，请等待他人释放");
      return;
    }
  }); //接收数据
}

function buf2hex(buffer) {
  // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function dataReader(hex) {
  let device_address = hex.substring(0, 2);
  let byte_read = hex.substring(4, 6);
if (device_address === "58") {
    if (byte_read === "20" && hex.length === 64) {
      //本应该到74，TCP buffer 长度限制在了64，有待解决
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
      } = meterPower.generalReader(hex);
      localObj.formPowerArr.find((obj) => obj.label === "设备地址").value =
        device_address;
      /*  localObj.formPowerArr.find((obj) => obj.label === "功能码").value =
        function_code;
      localObj.formPowerArr.find((obj) => obj.label === "读取字节数").value =
        byte_read; */
      localObj.formPowerArr.find((obj) => obj.label === "电压(V)").value =
        voltage?.toFixed(2);
      localObj.formPowerArr.find((obj) => obj.label === "电流(A)").value =
        current?.toFixed(2);
      localObj.formPowerArr.find((obj) => obj.label === "有用功率(KW)").value =
        active_power?.toFixed(2);
      localObj.formPowerArr.find(
        (obj) => obj.label === "无用功率(Kvar)"
      ).value = reactive_power?.toFixed(2);
      localObj.formPowerArr.find((obj) => obj.label === "视在功率(KVA)").value =
        apparent_power?.toFixed(2);
      localObj.formPowerArr.find((obj) => obj.label === "功率因数").value =
        power_factor?.toFixed(2);
      localObj.formPowerArr.find((obj) => obj.label === "频率(Hz)").value = 50//
      frequency?.toFixed(2);
      /* localObj.formPowerArr.find((obj) => obj.label === "CRC高位").value =
        crc_byte_high;
      localObj.formPowerArr.find((obj) => obj.label === "CRC低位").value =
        crc_byte_low; */
      localObj.queryTime = new Date(query_time).toLocaleString();
      return;
    } else if (byte_read === "04" && hex.length === 18) {
      let { energy, query_time } = meterPower.energyReader(hex);
      /* localObj.formPowerArr.find((obj) => obj.label === "设备地址").value =
        device_address;
      localObj.formPowerArr.find((obj) => obj.label === "功能码").value =
        function_code;
      localObj.formPowerArr.find((obj) => obj.label === "读取字节数").value =
        byte_read; */
      localObj.formPowerArr.find((obj) => obj.label === "电能(KWh)").value =
        energy;
      /* localObj.formPowerArr.find((obj) => obj.label === "CRC高位").value =
        crc_byte_high;
      localObj.formPowerArr.find((obj) => obj.label === "CRC低位").value =
        crc_byte_low; */
      localObj.queryTime = new Date(query_time).toLocaleString();
      return;
    } else console.log("有例外的？", hex, hex.length);
  } else console.log("未知设备", hex);
  // 根据设备地址做对应的数据&返回的字节数去解读；
}
</script>

<style>

</style>
