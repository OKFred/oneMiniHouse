<template>
  <view class="my-footer my-footer-shadow my-around-table"
    style="position: fixed; bottom: 0rem; width: 100%; background-color: white;  z-index: 5;">
    <slot name="myFooterSlot"></slot>
  </view>
</template>

<script setup>
//框架引入

</script>

<style>
.my-footer-shadow {
  box-shadow: 0px -3px 20px rgba(0, 0, 0, 0.06);
}
</style>
