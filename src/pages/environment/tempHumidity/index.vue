<template>
  <myUview :globalObj="globalObj" v-if="localObj.pageShow" />
  <myHeader :parentObj="localObj">
    <template #myHeaderSlot>
      <theTab :localObj="localObj" />
    </template>
  </myHeader>
  <view class="my-underground-purple" />
  <view v-if="localObj.tabs?.currentTab === '文本'">
    <view style="margin-top: 1vh" />
    <theForm :localObj="localObj" />
  </view>
  <view v-else-if="localObj.tabs?.currentTab === '图表'">
    <view style="margin-top: 1vh" />
    <theChart :localObj="localObj" />
  </view>
  <view style="padding-bottom: 10vh;" />
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
import { onLoad, onShow, onHide, onReachBottom } from "@dcloudio/uni-app";

//组件引入
import myUview from "/src/components/my-uview/index.vue";
import myHeader from "/src/components/my-header/index.vue";
import theTab from "./components/theTab.vue";
import theFooter from "./components/theFooter.vue";
import theForm from "./components/theForm.vue";
import theChart from "./components/theChart.vue";

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  globalObj: Object,
});

//本地变量和函数
let localObj = reactive({
  pageName: "温湿度",
  headerColor: "navyblue",
  titleStyle: "color: black !important;",
  showBackButton: true,
  pageShow: false,
  fn: {},
});
onShow(async () => {
  localObj.pageShow = true;
});

onHide(() => {
  localObj.pageShow = false;
})

</script>

<style></style>
