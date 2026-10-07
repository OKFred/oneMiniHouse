<template>
  <myUview :globalObj="globalObj" />
  <myHeader :parentObj="localObj">
    <template #myHeaderSlot>
      <theSearch :localObj="localObj" />
      <view style="padding-top: 45px" v-if="globalData['平台'] === '嵌入网页'" />
    </template>
  </myHeader>
  <view style="z-index: 12; position: relative; background: #F3F4F8; border-radius: 1rem 1rem 0 0;">
    <view style="padding-top: 1vh;" />
    <theMenu :localObj="localObj" />
    <view style="padding-bottom: 10vh;" />
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

import { onLoad, onShow, onHide, onReachBottom } from "@dcloudio/uni-app";

//组件引入
import myUview from "/src/components/my-uview/index.vue";
import myHeader from "/src/components/my-header/index.vue";

//组件引入
import theSearch from "./components/theSearch.vue" //引入自定义组件
import theMenu from "./components/theMenu.vue" //引入自定义组件

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  globalObj: Object,
});

//本地变量和函数
let localObj = reactive({
  pageName: "首页",
  headerColor: "#9acafc",
  titleStyle: "font-size: 1.3rem !important; font-weight: bold; color: white !important;",
  // showBackButton: true,
  hidePageName: globalData['平台'] === '嵌入网页',
});

onMounted(() => {
  // globalThis.app.changeTab({ tabName: "首页" });
});
</script>

<style></style>
