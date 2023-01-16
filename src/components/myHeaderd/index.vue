<template>
  <image
    class="my-header-image"
    :src="localObj.headerImage"
    style="width: 100%"
    mode="widthFix"
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
import headerBlack from "@/src/assets/header-black.png"; //引入图片
import headerBlue from "@/src/assets/header-blue.png"; //引入图片
import headerWhite from "@/src/assets/header-white.png"; //引入图片

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

//本地数据
const localObj = reactive({
  headerImage: "",
});

watch(
  () => props.parentObj,
  (newValue, oldValue) => {
    if (newValue) init(newValue);
    // console.log(newValue);
  },
  { immediate: true }
);

function init(parentObj) {
  localObj.headerImage =
    parentObj.headerColor === "black"
      ? headerBlack
      : parentObj.headerColor === "blue"
      ? headerBlue
      : headerWhite; //根据父系传入的颜色，设置背景图片
}

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
.my-header-image {
  position: fixed;
  width: 100%;
  z-index: 2;
}
.my-header-navback {
  position: fixed;
  top: 3rem;
  left: 1rem;
  font-size: 1.5rem;
  z-index: 5;
}
</style>
