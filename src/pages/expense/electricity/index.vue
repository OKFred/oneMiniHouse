<template>
  <myUview :globalObj="globalObj" />
  <myHeader :parentObj="localObj" />
  <myContent>
    <view :name="'myContentSlot'" style="margin: 0 0 10rem 0" />
    <template #myContentSlot v-if="localObj.tabs?.currentTab !== '文本'">
      <view style="margin-top: 5rem" />
      <theForm :localObj="localObj" />
    </template>
    <template #myContentSlot v-if="localObj.tabs?.currentTab === '图表'">
      <view style="margin-top: 1rem" />
      <theChart :localObj="localObj" />
    </template>
  </myContent>
  <theFooter :localObj="localObj" />
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
import myUview from "/src/components/my-uview/index.vue";
import myHeader from "/src/components/my-header/index.vue";
import myContent from "/src/components/my-content/index.vue";

import theFooter from "./components/theFooter.vue"; //引入自定义组件
import theForm from "./components/theForm.vue"; //引入自定义组件
import theChart from "./components/theChart.vue"; //引入自定义组件
 
//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;


const props = defineProps({
  globalObj: Object,
});

function setData(obj) {
  Object.assign(localObj, obj);
}

async function fetchData() {
  console.log("📶准备获取数据");
  console.log(localObj);
}

//当前项目的所有变量和函数
let localObj = reactive({
  // debug: true,
  pageName: "智能家居",
  headerColor: "blue",
  requestParamObj: {},
  fetchData,
});

</script>

<style></style>
