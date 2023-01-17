<template>
  <view
    class="my-header-color"
    :style="
      'background-color:' +
      (parentObj.headerColor? parentObj.headerColor : 'white')"
  />
  <view class="my-header">
    <view class="my-center">
      <view
        :class="
          'my-font ' +
          (parentObj.headerColor !== 'white' ? 'my-white-font' : '')
        "
      >
        {{ parentObj.pageName }}
      </view>
    </view>
  </view>
  <van-icon
    v-show="parentObj.showBackButton"
    :class="
      'my-header-navback ' +
      (parentObj.headerColor !== 'white' ? 'my-white-font' : '')
    "
    name="arrow-left"
    @tap="onNavBack"
  />
</template>

<script setup>
import { reactive, watch, onMounted, defineProps } from "vue";

definePageConfig({
  navigationStyle: "custom",
  component: true,
  usingComponents: {
    "van-icon": "@vant/weapp/icon/index",
  },
}); //taro的页面配置

//父系入参
let app = globalThis.app;
const { onNavBack } = app;

const props = defineProps({
  parentObj: Object,
});

/* onMounted(() => {
  console.log("加载组件");
}); */
</script>

<style>
/* 顶部的标题区域，标题行，背景图，标题，标签，以及返回按钮 */
.my-header {
  position: fixed;
  width: 100%;
  z-index: 3;
  margin-top: 3.3rem;
}
.my-header-color {
  position: fixed;
  width: 100%;
  z-index: 2;
  height: 5.4rem;
}
.my-header-navback {
  position: fixed;
  top: 3rem;
  left: 1rem;
  font-size: 1.5rem;
  z-index: 5;
}
</style>
