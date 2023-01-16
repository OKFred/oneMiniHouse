<template>
  <myheaderd :parentObj="localObj" />
  <view class="my-underground" />
  <view style="padding-top: 5.4rem" />
  <mytabd :parentObj="localObj.tabs" class="my-top-tab" />
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
import myheaderd from "@/src/components/myheaderd/index.vue";
import mytabd from "@/src/components/mytabd/index.vue";

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
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
  pageName: "支出-电表",
  headerColor: "blue",
  showBackButton: true,
  tabs: {
    onTabChange,
    currentTab: "文本",
    tabArr: [
      { label: "文本", value: undefined },
      { label: "图表", value: undefined },
    ],
  },
});

function onTabChange(params) {
  let { e, title, parent } = params;
  let confirmed = title === "文本" ? 0 : 1;
  // clearRequestHistory();
  let { requestParamObj, tabs } = props.localObj;
  requestParamObj["keyName"] = confirmed;
  tabs.currentTab = title;
  setData({ requestParamObj, tabs });
  console.log("切换了标签");
  // fetchData();
} //切换标签则清理缓存
</script>

<style>
/* 标签栏置顶 */
.my-top-tab {
  width: 100%;
  z-index: 2;
  position: fixed;
  top: 5.5rem;
}
</style>
