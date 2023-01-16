<template>
  <image
    v-if="parentObj.headerColor"
    class="my-header-image"
    :src="'@/assets/header-' + parentObj.headerColor + '.png'"
    style="width: 100%"
    mode="widthFix"
  />
  <view class="my-header">
    <view class="my-center">
      <view
        :class="
          'my-font' + parentObj.headerColor !== 'white' ? 'my-white-font' : ''
        "
      >
        {{ parentObj.pageName }}
      </view>
    </view>
  </view>
  <!-- <van-icon
    wx:if="{{ showBackButton }}"
    class="my-header-navback {{ headerColor !== 'white' ? 'my-white-font' : '' }}"
    name="arrow-left"
    bind:tap="onNavback"
  /> -->
</template>

<script setup>
import { reactive, watch, onMounted, defineProps } from "vue";

//父系入参
const props = defineProps({
  parentObj: Object,
});

watch(
  () => props.parentObj,
  (newValue, oldValue) => {
    if (newValue) console.log(newValue);
  },
  { immediate: true }
);

onMounted(() => {
  console.log("加载组件");
});
</script>

<style scoped>
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
