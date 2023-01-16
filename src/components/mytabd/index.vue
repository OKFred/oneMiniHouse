<template>
  <van-tabs v-if="parentObj.currentTab !== undefined" :ellipsis="false"
    :active="parentObj.tabArr.findIndex((item) => item.label === parentObj.currentTab)" custom-class="my-tab-area"
    @change="(e) => parentObj.onTabChange({ e, ...e.detail, parent: parentObj.parent })"
    :wrap-class="`my-tab-box ${parentObj.round ? 'my-tab-round' : ''}`"
    :tab-active-class="parentObj.color === 'black' ? 'my-active-tab-black' : 'my-active-tab'"
    :tab-class="`my-tab ${parentObj.size === 'small' ? '' : 'my-normal-tab'}`" line-width="30px" line-height="4px"
    :color="parentObj.color === 'black' ? '#181818' : '#318CFB'">
    <van-tab v-for="(item, index) in parentObj.tabArr" :key="index" :title="item.label" :info="item.value" />
  </van-tabs>
</template>

<script setup>
import Taro from "@tarojs/taro";
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
    /*     default: {
        tabArr: {
            type: Array,
        }, //所有标签
        currentTab: {
            type: String,
          },
        } */
  },
});


definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    "van-tab": "@vant/weapp/tab/index",
    "van-tabs": "@vant/weapp/tabs/index"
  },
});
</script>

<style>
/* .my-tab-area {
  border-radius: 0.5rem 0;
} */

.my-tab-box {
  height: 3rem !important;
  background-color: white;
}

.my-tab-round {
  border-radius: 0.5rem 0.5rem 0 0 !important;
}

.my-tab {
  font-weight: bold !important;
  font-family: 等线 !important;
  color: #959595 !important;
}

.my-normal-tab {
  font-weight: bold !important;
  font-family: 等线 !important;
  font-size: 1.2rem !important;
  color: #959595 !important;
}

/* 小红点位置调整 */
.my-tab>view>van-info>.van-info {
  top: -0.8rem !important;
  right: 0.8rem !important;
  display: inline-flex;
}

.my-active-tab {
  color: #008dff !important;
}

.my-active-tab-black {
  color: #181818 !important;
}
</style>
