<template>
  <myUview :globalObj="globalObj" />
  <theHeader :localObj="localObj" />
  <mycontents>
    <slot-view :name="'myContentSlot'" style="margin: 0 0 7rem 0" >
      <view style="margin-top: 0.5rem" />
      <theForm :localObj="localObj" />
    </slot-view>
    <slot-view :name="'myContentSlot'" style="margin: 0 0 7rem 0" v-if="localObj.tabs?.currentTab === '图表'">
      <view style="margin-top: 1rem" />
      <theChart :localObj="localObj" />
    </slot-view>
  </mycontents>
  <theFooter :localObj="localObj" />
</template>

<script setup>
//框架引入
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
import myUview from "/src/components/my-uview/index.vue";
import theHeader from "./components/theHeader.vue"; //引入自定义组件
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
