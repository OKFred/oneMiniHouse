<template>
  <view style="background-color: white;">
    <u-tabs :list="parentObj.tabArr" :current="parentObj.currentIndex" @click="onTabChange" :scrollable="false"
      lineColor="#114FFF" :activeStyle="`color:#114FFF; font-size: 1rem; font-weight: bold;`"
      :inactiveStyle="`color:#181818; font-size: 1rem; font-weight: bold;`" lineWidth="40" />
  </view>
</template>

<script setup>
import { reactive, watch, onMounted } from "vue";

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          typeof obj.onTabChange !== "function"
        )
          return console.log("⚠️标签切换处理函数未传入");
      }
    },
  },
});

function onTabChange(obj) {
  let { name, index } = obj;
  if (name === undefined || index === undefined) return;
  console.log('当前tab:', name);
  let tabs = props.parentObj;
  tabs.currentTab = name;
  tabs.currentIndex = index;
  props.parentObj.onTabChange?.(tabs);
}
</script>

<style></style>
