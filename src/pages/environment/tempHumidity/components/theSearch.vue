<template>
  <!-- 图表 -->
  <view class="my-center-vertically">
    <mysearchd :parentObj="localObj.searches" class="my-search-box" />
    <view class="sea_right" @tap="onFilter">
      <van-icon name="filter-o" color="#7B7B7B" size="26px" />
      <text>筛选</text>
    </view>
  </view>
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
import mysearchd from "@/src/components/mysearchd/index.vue"

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    "van-tab": "@vant/weapp/tab/index",
    "van-tabs": "@vant/weapp/tabs/index",
    "van-icon": "@vant/weapp/icon/index",
    "van-field": "@vant/weapp/field/index",
    "van-image": "@vant/weapp/image/index",
    "van-button": "@vant/weapp/button/index",
    "van-search": "@vant/weapp/search/index",
    "van-popup": "@vant/weapp/popup/index",
    "van-datetime-picker": "@vant/weapp/datetime-picker/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  searches: {
    onSearch,
    userSearch: '',
    placeholder: '搜索',
  }
});

// 筛选
function onFilter() {
  props.localObj.pops.his_filter_show = true;
}

function onSearch(params) {
  let { e, value, parent } = params;
  console.log("搜索", value);
}
</script>

<style>
/* 图表 */
.my-search-box {
  width: 72vw;
  height: 2.5rem;
  display: inline-flex;
}

.sea_right {
  width: 150rpx;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
}

.sea_right text {
  font-size: 35rpx;
  color: #7b7b7b;
}
</style>
