<template>
  <myUview :globalObj="globalObj" />
  <myHeader :parentObj="localObj" />
  <view class="my-underground" />
  <myContent>
    <template #myContentSlot>
      <view style="margin-top: 5rem" />
      <view class="my-font">设置</view>
      <view style="margin-top: 1rem" />
      <theForm :localObj="localObj" />
    </template>
  </myContent>
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
  headerColor: "white",
});
/*
watch(
    () => props.globalObj.msgs[localObj.name],
    (newValue, oldValue) => {
        if (newValue) distribute(newValue)
    },
    { immediate: true },
) //处理来自App.vue的消息分发 */
</script>

<style>

</style>
