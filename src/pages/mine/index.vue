<template>
  <myUview :globalObj="globalObj" v-if="localObj.pageShow" />
  <myHeader :parentObj="localObj">
    <template #myHeaderSlot>
      <view style="padding-top: 45px" v-if="globalData['平台'] === '嵌入网页'" />
      <theProfile :localObj="localObj" />
    </template>
  </myHeader>
  <view style="z-index: 12; position: relative; background: #F3F4F8; border-radius: 1rem 1rem 0 0;">
    <view style="padding-top: 1vh;" />
    <theForm :localObj="localObj" />
    <view style="padding-bottom: 70vh;" />
  </view>
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
import { onShow, onHide } from "@dcloudio/uni-app";

import { serverQuery, serverSaveQuery } from "./components/data.js";

//组件引入
import myUview from "/src/components/my-uview/index.vue";
import myHeader from "/src/components/my-header/index.vue";
import theProfile from "./components/theProfile.vue";
import theForm from "./components/theForm.vue"; //引入自定义组件

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  globalObj: Object,
});

onMounted(() => {
  // globalThis.app.changeTab({ tabName: "我的" });
});

//本地变量和函数
let localObj = reactive({
  pageName: "我的",
  headerColor: "navyblue",
  hidePageName: globalData['平台'] === '嵌入网页',
  fn: {
    serverQuery,
    serverSaveQuery,
  }
});

onShow(async () => {
  localObj.pageShow = true;
})
onHide(() => {
  localObj.pageShow = false;
})

</script>

<style></style>
