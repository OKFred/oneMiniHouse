<template>
  <view class="my-footer my-around-table" style="
      height: 6vh;
      position: fixed;
      bottom: 0rem;
      width: 100%;
      background-color: white;
      padding: 1rem 0;
      border-top: 0.1rem solid #e6e6e8;
      box-shadow: 0px -3px 20px rgba(0,0,0,0.06);
      z-index: 5;
    ">
    <slot name="myFooterSlot"></slot>
  </view>
</template>

<script setup>
//框架引入
definePageConfig({
  navigationStyle: "custom",
  usingComponents: {},
});
</script>

<style>

</style>
