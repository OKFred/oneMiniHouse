<template>
  <view class="my-sticky-header">
    <u-navbar :safeAreaInsetTop="true" :fixed="false" :border="parentObj.headerColor === 'transparent' ? false : true"
      :bgColor="parentObj.headerColor || 'white'" :title="parentObj.hidePageName ? '' : parentObj.pageName"
      :titleStyle="parentObj.titleStyle || 'color: black;'" :leftIcon="parentObj.showBackButton ? 'arrow-left' : ''"
      @leftClick="parentObj.showBackButton && onNavBack()" />
    <slot name="myHeaderSlot" />
  </view>
</template>

<script setup>
import { reactive, watch, onMounted, defineProps } from "vue";

//父系入参 
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  parentObj: Object,
});

</script>

<style>
.my-sticky-header {
  position: sticky;
  top: 0px;
  z-index: 11;
  width: 100%
}
</style>
