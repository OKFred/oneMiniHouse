<template>
  <myfooters>
    <template #myFooterSlot>
      <view slot="myFooterSlot" class="my-center my-center-vertically my-around-table" style="width: 100%">
        <view style="width: 88vw" @tap="onCancel">
          <mybuttond :parentObj="localObj.footers.buttons" />
        </view>
      </view>
    </template>
  </myfooters>
</template>

<script setup>
//框架引入
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

//组件引入
import myfooters from "@/src/components/myfooters/index.vue"; //引入组件
import mybuttond from "@/src/components/mybuttond/index.vue"; //引入组件

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    "van-button": "@vant/weapp/button/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  // debug: true,
  footers: {
    buttons: {
      text: "返回",
      disabled: false,
    },
    // readOnly: true, //只读
  },
});

function onCancel() {
  app.onNavBack()
}

function onSubmit() {
  console.log("提交表单");
}
</script>

<style>

</style>
