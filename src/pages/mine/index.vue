<template>
  <mytaro />
  <myHeaderd :parentObj="localObj" />
  <view class="my-underground" />
  <mycontents>
    <slot-view :name="'myContentSlot'" style="margin-top: 7rem; margin-bottom: 5rem">
      <view class="my-font">设置</view>
      <view style="margin-top: 1rem" />
      <theForm :localObj="localObj" />
    </slot-view>
  </mycontents>
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
import mytaro from "@/src/components/mytaro/index.vue" //公共页面配置
import myHeaderd from "@/src/components/myheaderd/index.vue"; //引入组件
import theForm from "./components/theForm.vue"; //引入自定义组件

definePageConfig({
  navigationStyle: "custom",
  enableShareTimeline: true,
  enableShareAppMessage: true,
  usingComponents: {
    mycontents: "@/src/components/mycontents/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  globalObj: Object,
});

onMounted(() => {
  globalThis.app.changeTab({ tabName: "我的" });
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
