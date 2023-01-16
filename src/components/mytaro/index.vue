<template>
  <text />
</template>

<script setup>
//框架引入
import Taro from "@tarojs/taro";

//组件引入

definePageConfig({
  navigationStyle: "custom",
  enableShareTimeline: true,
  enableShareAppMessage: true,
});

Taro.useShareAppMessage((res) => {
  let { path } = Taro.getLaunchOptionsSync();
  // console.log(res.from, path);
  return {
    title: globalThis.app.globalData.appPublicName,
    path,
  }; //转发到聊天
});
Taro.useShareTimeline((res) => {
  let { path } = Taro.getLaunchOptionsSync();
  // console.log(res.from, path);
  return {
    title: globalThis.app.globalData.appPublicName,
    path,
  };  //转发到朋友圈
});


</script>

<style>

</style>
