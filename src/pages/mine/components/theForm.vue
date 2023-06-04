<template>
  <!-- 表单 -->
  <view class="white-container">
    <myCardsListd :parentObj="localObj.forms[0]" />
  </view>
  <view style="margin-top: 1rem" />
</template>

<script setup>
//框架引入
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

import { onLoad, onShow } from "@dcloudio/uni-app";

//组件引入
import myCardsListd from "/src/components/mycards-listd/index.vue"; //引入组件

import mineAPI from "./api.js"; //数据读写操作
import bg from "/src/main/bg.js";

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  globalObj: Object,
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数

setData({
  forms: [
    {
      onEdit,
      onEditComplete,
      parent: "主表单",
      formArr: [
        {
          key: "address",
          label: "服务器地址",
          value: bg.read('address')?.address || "tcp.fred.wiki",
          editing: false,
          type: "text",
          placeholder: "请输入服务器地址",
          required: true
        },
        {
          key: "port",
          label: "端口号",
          value: bg.read('port')?.port || "8899",
          editing: false,
          type: "text",
          placeholder: "请输入端口号",
          required: true
        },
      ],
    },
  ],
});

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
        },
        fail: (e) => {
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
async function onEditComplete(params) {
  let { obj, index, value, parent } = params;
  let { formArr } = props.localObj.forms.find((obj) => obj.parent === parent);
  formArr[index].editing = false;
  let address_original = formArr.find((obj) => obj.key === "address").value;
  let port_original = formArr.find((obj) => obj.key === "port").value;
  if (obj.key === 'address' && address_original === value.trim()) return console.log('地址未修改');
  if (obj.key === 'port' && port_original === value.trim()) return console.log('端口未修改');
  formArr[index].value = value;
  console.log("表单已更新", JSON.parse(JSON.stringify(formArr)));
  let address = formArr.find((obj) => obj.key === "address").value;
  let port = formArr.find((obj) => obj.key === "port").value;
  let { status, result } = await mineAPI.serverSaveQuery({ address, port });
  if (!status) return globalThis.queryResult(status, result);
  globalThis.app.onRestart();
}

</script>

<style>

</style>
