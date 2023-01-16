<template>
  <mytaro />
  <theHeader :localObj="localObj" />
  <mycontents>
    <slot-view :name="'myContentSlot'" style="margin: 0 0 7rem 0" v-show="localObj.tabs?.currentTab === '文本'">
      <!-- <theFilter :localObj="localObj" /> -->
      <!-- <view style="margin-top: 0.5rem" /> -->
      <!-- <theTable :localObj="localObj" /> -->
      <view style="margin-top: 0.5rem" />
      <theForm :localObj="localObj" />
      <!-- <theDialog :localObj="localObj" /> -->
    </slot-view>
    <slot-view :name="'myContentSlot'" style="margin: 0 0 7rem 0" v-show="localObj.tabs?.currentTab === '图表'">
      <view style="margin-top: 1rem" />
      <theChart :localObj="localObj" />
      <!-- <theSearch :localObj="localObj" /> -->
      <!-- 👇内部有van-tabs，自带bug，需要v-if重新渲染，才能正确显示底部条位置 -->
      <!-- <theList :localObj="localObj" v-if="localObj.tabs?.currentTab === '图表'" />
      <thePop :localObj="localObj" /> -->
      <!-- <thePlate :localObj="localObj" /> -->
      <!-- <theSwipe :localObj="localObj" /> -->
    </slot-view>
  </mycontents>
  <theFooter :localObj="localObj" />
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
import mytaro from "@/src/components/mytaro/index.vue" //公共页面配置
import theHeader from "./components/theHeader.vue"; //引入自定义组件
import theFooter from "./components/theFooter.vue"; //引入自定义组件
import theFilter from "./components/theFilter.vue"; //引入自定义组件
import theTable from "./components/theTable.vue"; //引入自定义组件
import theForm from "./components/theForm.vue"; //引入自定义组件
import theDialog from "./components/theDialog.vue"; //引入自定义组件
import theSearch from "./components/theSearch.vue"; //引入自定义组件
import theList from "./components/theList.vue"; //引入自定义组件
import thePop from "./components/thePop.vue"; //引入自定义组件
import theChart from "./components/theChart.vue"; //引入自定义组件
// import thePlate from "./components/thePlate.vue"; //引入自定义组件
// import theSwipe from "./components/theSwipe.vue"; //引入自定义组件

definePageConfig({
  navigationStyle: "custom",
  enableShareTimeline: true,
  enableShareAppMessage: true,
  usingComponents: {
    "ec-canvas": "@/src/components/ec-canvas/ec-canvas",
    mycontents: "@/src/components/mycontents/index",
    "van-tab": "@vant/weapp/tab/index",
    "van-tabs": "@vant/weapp/tabs/index",
    "van-icon": "@vant/weapp/icon/index",
    "van-field": "@vant/weapp/field/index",
    "van-button": "@vant/weapp/button/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

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

<style>

</style>
